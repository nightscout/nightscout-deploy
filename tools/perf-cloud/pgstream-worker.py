#!/usr/bin/env python3
"""Finite SUT/driver actions for the controller-owned first-thousand run."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import selectors
import signal
import subprocess
import sys
import tarfile
import time

ROOT=Path('/opt/nsperf')
RESULTS=('probe.json','k6-summary.json','fanout.json','generator-metrics.json','event-loop.jsonl','k6-launch.json','generator-provenance.json','probe-accounting.json','generator-processes.json','generator-public-result.json')
OPTIONAL_RESULTS={'probe-accounting.json','generator-processes.json','generator-public-result.json'}
TRAFFIC=('probe-accounting.cjs','package.json','package-lock.json','tenants.private.json','probe.js','workload.js','recovery.cjs')

def need(ok,code):
    if not ok:raise RuntimeError(code)

def command(args,seconds=120,input=None):
    # Each owned action child has a killable group. Deadline/signal exceptions
    # unwind this child before the controller begins collection and exact down.
    args=list(map(str,args))
    process=subprocess.Popen(args,stdin=subprocess.PIPE if input is not None else None,
                             stdout=subprocess.PIPE,stderr=sys.stderr,start_new_session=True)
    try:
        out,_=process.communicate(input=input,timeout=seconds)
        if process.returncode:raise subprocess.CalledProcessError(process.returncode,args,output=out)
        return out
    except BaseException:
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.wait(timeout=5)
        raise

@contextmanager
def cold_setup(spec):
    # Older source packets retain their contract. New packets bind this absolute
    # cutoff before bootstrapping; it is not extended by reconnects or retries.
    deadline=spec.get('lastNewPointAt')
    if deadline is None:
        yield
        return
    need(type(deadline) in (int,float) and time.time()<deadline,'PGCAL_COLD_SETUP_CUTOFF')
    watched=(signal.SIGALRM,signal.SIGHUP,signal.SIGTERM)
    previous={kind:signal.getsignal(kind) for kind in watched}
    def interrupted(kind,frame):
        # Let command/logged_command kill and reap their exact process groups.
        for sig in watched:signal.signal(sig,signal.SIG_IGN)
        raise RuntimeError('PGCAL_COLD_SETUP_CUTOFF' if kind==signal.SIGALRM else 'PGCAL_CONTROLLER_LOST')
    try:
        for kind in watched:signal.signal(kind,interrupted)
        signal.setitimer(signal.ITIMER_REAL,max(0.001,deadline-time.time()))
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        for kind,handler in previous.items():signal.signal(kind,handler)

BOOTSTRAP_LOG_MAX_BYTES=1048576

def logged_command(name,args,seconds=120):
    """Persist bounded private stdout/stderr and completion before any assertion."""
    need(re.fullmatch(r'[a-z0-9-]{1,64}',name),'PGCAL_BOOTSTRAP_LOG_NAME')
    folder=ROOT/'logs';folder.mkdir(mode=0o700,exist_ok=True)
    args=list(map(str,args));started=time.monotonic();failure=None;stdout=bytearray()
    sizes={'stdout':0,'stderr':0};process=None
    with (folder/(name+'.stdout')).open('xb') as out,(folder/(name+'.stderr')).open('xb') as err:
        os.chmod(out.name,0o600);os.chmod(err.name,0o600)
        try:
            process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            with selectors.DefaultSelector() as selected:
                selected.register(process.stdout,selectors.EVENT_READ,('stdout',out))
                selected.register(process.stderr,selectors.EVENT_READ,('stderr',err))
                while selected.get_map():
                    remaining=seconds-(time.monotonic()-started)
                    if remaining<=0:raise subprocess.TimeoutExpired(args,seconds)
                    for key,_ in selected.select(min(remaining,1)):
                        stream,file=key.data;chunk=os.read(key.fd,65536)
                        if not chunk:
                            selected.unregister(key.fileobj);continue
                        keep=chunk[:max(0,BOOTSTRAP_LOG_MAX_BYTES-sizes[stream])]
                        file.write(keep);file.flush();sizes[stream]+=len(chunk)
                        if stream=='stdout':stdout.extend(keep)
                        if sizes[stream]>BOOTSTRAP_LOG_MAX_BYTES:raise RuntimeError('PGCAL_BOOTSTRAP_LOG_BOUND')
            process.wait(timeout=max(0.001,seconds-(time.monotonic()-started)))
        except BaseException as error:
            failure=type(error).__name__
            if process is not None and process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
            raise
        finally:
            if process is not None:
                process.stdout.close();process.stderr.close()
            write(folder/(name+'.json'),{'program':args[0],'returnCode':process.returncode if process is not None else None,
                  'failureType':failure,'elapsedSeconds':time.monotonic()-started,'timeoutSeconds':seconds,
                  'bytesObserved':sizes,'maxBytesPerStream':BOOTSTRAP_LOG_MAX_BYTES,
                  'stdout':name+'.stdout','stderr':name+'.stderr','scope':'private bootstrap command evidence; no image-import acceptance inferred'})
    if process.returncode:raise subprocess.CalledProcessError(process.returncode,args,bytes(stdout))
    return bytes(stdout)

def read(path):return json.loads(Path(path).read_text())
def write(path,value):Path(path).write_text(json.dumps(value));Path(path).chmod(0o600)
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

MARKER=Path('/etc/nsperf-run.json')
METADATA_BASE='http://169.254.169.254/metadata/v1/'

def metadata_text(field):
    # Fixed provider-local endpoints, no proxy, redirects or caller-selected URL.
    import urllib.request
    need(field in ('id','interfaces/public/0/ipv4/address','interfaces/private/0/ipv4/address'),'PGCAL_METADATA_FIELD')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open(METADATA_BASE+field,timeout=2)as response:
            need(response.getcode()==200,'PGCAL_METADATA_STATUS');raw=response.read(129)
        need(0<len(raw)<=128,'PGCAL_METADATA_BOUND');return raw.decode('ascii').strip()
    except RuntimeError:raise
    except Exception:raise RuntimeError('PGCAL_METADATA_UNAVAILABLE')from None

def nic_mac(interface):
    need(re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,14}',interface)is not None,'PGCAL_HOST_INTERFACE')
    return(Path('/sys/class/net')/interface/'address').read_text().strip()

def expected_host(spec,role,action):
    need(role in ('sut','driver'),'PGCAL_HOST_ROLE_REQUIRED')
    sut={'prepare','port','admit','session','deploy','export','client-import'};driver={'generator-session','client-export'}
    need(action in sut|driver|{'bind-host','bootstrap','collect','down'}and(action not in sut or role=='sut')and(action not in driver or role=='driver'),'PGCAL_ACTION_ROLE')
    host=spec['hosts'][role];need(isinstance(host.get('providerId'),str)and re.fullmatch('[1-9][0-9]{0,19}',host['providerId'])is not None,'PGCAL_PROVIDER_ID_SHAPE');return host

def base_context(final=False):
    spec=read(ROOT/'input/spec.json');metadata=MARKER.stat()
    need(not MARKER.is_symlink()and metadata.st_uid==0 and metadata.st_mode & 0o777==0o444,'PGCAL_OWNER_MARKER_PERMISSIONS')
    marker=read(MARKER);need(marker.get('run_id')==spec['cloudId'],'PGCAL_OWNER_MARKER')
    need(final or min(marker['expires_at'],spec['expiresAt'])-time.time()>540,'PGCAL_DEADLINE')
    need(spec['profile']=='remote-pgstream-calibration-v1','PGCAL_PROFILE');return spec,marker

def bind_host(role):
    spec,marker=base_context();host=expected_host(spec,role,'bind-host');identity=metadata_text('id')
    need(identity==host['providerId'],'PGCAL_PHYSICAL_PROVIDER_ID')
    need(metadata_text('interfaces/public/0/ipv4/address')==host['publicIPv4']and metadata_text('interfaces/private/0/ipv4/address')==host['privateIPv4'],'PGCAL_PHYSICAL_HOST_ADDRESS')
    if role=='sut':need(nic_mac(spec['transport']['interface'])==spec['transport']['mac'],'PGCAL_PHYSICAL_SUT_NIC')
    if 'role'in marker or'provider_id'in marker:
        need(marker.get('role')==role and marker.get('provider_id')==identity and marker.get('metadata_provider_id')==identity,'PGCAL_BOUND_HOST_REFUSED_RELABEL')
    need(os.geteuid()==0,'PGCAL_ROOT_HOST_BINDING_REQUIRED')
    value={**marker,'role':role,'provider_id':identity,'metadata_provider_id':identity,'public_ipv4':host['publicIPv4'],'private_ipv4':host['privateIPv4'],'expires_at':min(marker['expires_at'],spec['expiresAt'])}
    temporary=MARKER.with_name(MARKER.name+'.binding-'+str(os.getpid()));fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
    try:
        with os.fdopen(fd,'w')as stream:json.dump(value,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),0o444);os.fchown(stream.fileno(),0,0)
        os.replace(temporary,MARKER)
    finally:
        try:temporary.unlink()
        except FileNotFoundError:pass
    return{'status':'PHYSICAL_HOST_ROLE_BOUND','role':role,'providerId':identity,'expiryExtended':False}

def context(final=False,role=None,action=None):
    spec,marker=base_context(final);host=expected_host(spec,role,action)
    need(marker.get('role')==role and marker.get('provider_id')==host['providerId']and marker.get('metadata_provider_id')==host['providerId'],'PGCAL_HOST_ROLE_PROVIDER_BINDING')
    need(marker.get('public_ipv4')==host['publicIPv4']and marker.get('private_ipv4')==host['privateIPv4'],'PGCAL_HOST_ADDRESS_BINDING')
    # Collection/down retain recorded exact identity if metadata or SSH health is lost.
    # The outer controller still deletes exact provider IDs independently of either.
    if not final:need(metadata_text('id')==host['providerId'],'PGCAL_PHYSICAL_PROVIDER_ID')
    return spec

def worker(args,seconds=1800):
    account=pwd.getpwuid(1000);need(account.pw_gid==1000,'PGCAL_RUNTIME_GID')
    env=['env','-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME='+account.pw_dir,'LANG=C.UTF-8','DOCKER_HOST=unix:///var/run/docker.sock']
    return command(['setpriv','--reuid','1000','--regid','1000','--init-groups',*env,*args],seconds)

def helper():return ROOT/'alignment/tools/mt-bench/remote-pgstream'
def cellargs(action):return ['python3',helper()/'cell.py',action,'--binding',ROOT/'input/binding.json','--cell',ROOT/'work/cell']

def prepare_diagnostic_dependencies(spec,run=worker):
    """Use the canonical owned lockfile installer before diagnostic admission.

    This is setup work on the same finite SUT, outside application quotas. The
    adapter then verifies and copies this exact private tree into its cell.
    """
    if spec.get('diagnosticResourceProfile') is None:return None
    directory=ROOT/'work/generator-bootstrap'
    need(not directory.exists() and not directory.is_symlink(),'PGCAL_DEPENDENCY_TARGET_EXISTS')
    program=r'''import json,sys
from pathlib import Path
root=Path(sys.argv[1]);source=Path(sys.argv[2]);spec=json.loads(sys.argv[3])
sys.path.insert(0,str(root/'alignment/tools/mt-bench/m7-joined'))
import adapter as a
need=a.require
need(not source.exists() and not source.is_symlink(),'PGCAL_DEPENDENCY_TARGET_EXISTS')
source.mkdir(mode=0o700)
a.command(['git','clone','--no-hardlinks','--no-checkout',root/'sources/core.git',source/'core'])
a.command(['git','-C',source/'core','checkout','--detach',spec['pins']['core']])
need(a.command(['git','-C',source/'core','rev-parse','HEAD']).strip()==spec['pins']['core'],'PGCAL_DEPENDENCY_SOURCE_HEAD')
a.setup_generator(source,{'pair':{'core':spec['pins']['core'],'deploy':spec['pins']['deploy']},'imageId':spec['pins']['app']})
'''
    run(['python3','-c',program,ROOT,directory,json.dumps(spec)])
    receipt=directory/'generator-provenance.json'
    need(receipt.is_file() and not receipt.is_symlink(),'PGCAL_DEPENDENCY_RECEIPT_REQUIRED')
    return {'root':str(directory/'dependencies'),'receipt':str(receipt),'sha256':digest(receipt)}


def prepare_arguments(spec,dependencies=None):
    """The existing cell parser receives the reviewed workload, not worker defaults."""
    cadence=spec['cadence']
    args=cellargs('prepare')+['--core-repo',ROOT/'sources/core.git','--core-commit',spec['pins']['core'],'--deploy-repo',ROOT/'sources/deploy.git','--deploy-commit',spec['pins']['deploy'],'--image',spec['pins']['app'],'--postgres-image',spec['pins']['postgres'],'--receipt',ROOT/'input/receipt.json','--profile','pgstream-sample','--run-purpose','discovery','--completion-contract',spec['completionContract'],'--diagnostics',spec['diagnostics'],'--tenants',str(spec['tenants']),'--replicas','1']
    for key,flag in [('warmupSeconds','warmup-seconds'),('idleSeconds','idle-seconds'),('loadSeconds','load-seconds'),('accel','accel'),('hotFactor','hot-factor'),('samplerIntervalSeconds','sampler-interval'),('probeEveryMs','probe-every-ms'),('socketsPerTenant','sockets-per-tenant')]:args+=['--'+flag,str(cadence[key])]
    total=spec.get('resourcePlan',{}).get('logicalPollingClients',cadence['socketsPerTenant']*spec['tenants'])
    if total!=cadence['socketsPerTenant']*spec['tenants']:args+=['--logical-polling-clients',str(total)]
    if 'offeredRps' in cadence:args+=['--offered-rps',str(cadence['offeredRps'])]
    if 'pgstreamTopology' in spec or 'diagnosticResourceProfile' in spec:
        need(spec.get('pgstreamTopology')=='external-service-v1' and spec.get('diagnosticResourceProfile')=='local-diagnostic-external-pgstream-4cpu-8g-v1','PGCAL_EXPLICIT_TOPOLOGY')
        need(spec.get('receipt',{}).get('remotePgstreamTopology')==spec['pgstreamTopology'] and spec.get('receipt',{}).get('remoteDiagnosticResourceProfile')==spec['diagnosticResourceProfile'],'PGCAL_TOPOLOGY_RECEIPT')
        args+=['--pgstream-topology',spec['pgstreamTopology'],'--diagnostic-resource-profile',spec['diagnosticResourceProfile']]
    if spec.get('diagnosticResourceProfile') is not None:
        need(isinstance(dependencies,dict) and set(dependencies)=={'root','receipt','sha256'} and re.fullmatch('[a-f0-9]{64}',dependencies.get('sha256','')),'PGCAL_DIAGNOSTIC_DEPENDENCIES_REQUIRED')
        args+=['--generator-dependencies',dependencies['root'],'--generator-dependency-receipt',dependencies['receipt'],'--generator-dependency-receipt-sha256',dependencies['sha256']]
    args+=['--primer-concurrency',str(spec.get('primerConcurrency',1))]
    return args

def configure_legacy_image_store(config=Path('/etc/docker/daemon.json')):
    # Fresh campaign hosts only: never repoint a populated or preconfigured daemon.
    need(not config.exists() and not config.is_symlink(),'PGCAL_DAEMON_CONFIG_EXISTS')
    need(not command(['docker','ps','-aq']).strip(),'PGCAL_DAEMON_CONTAINERS_EXIST')
    need(not command(['docker','image','ls','-aq']).strip(),'PGCAL_DAEMON_IMAGES_EXIST')
    command(['systemctl','stop','docker.service','docker.socket'])
    config.parent.mkdir(parents=True,exist_ok=True)
    config.write_text(json.dumps({'features':{'containerd-snapshotter':False}})+'\n')
    config.chmod(0o644)
    command(['systemctl','enable','--now','docker'])
    info=json.loads(logged_command('legacy-store-admission',['docker','info','--format','{{json .}}']))
    need(info.get('Driver')=='overlay2','PGCAL_LEGACY_STORE_DRIVER')

def bootstrap(spec,role):
    # Strict fresh directories precede admission logging; reused hosts still refuse.
    for name in ('work','logs','sources','alignment'):(ROOT/name).mkdir(mode=0o755)
    command(['bash','-ceu',"export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq docker.io docker-compose-v2 git curl ca-certificates openssl bc xz-utils python3 procps iproute2 iptables sudo"],900)
    configure_legacy_image_store()
    node=ROOT/'node.tar.xz'
    command(['curl','-fsS','--retry','3','https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz','-o',node],300)
    need(digest(node)=='6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6','PGCAL_NODE_BYTES')
    command(['tar','-xJf',node,'-C','/usr/local','--strip-components=1'])
    command(['systemctl','enable','--now','docker'])
    account=pwd.getpwuid(1000);need(account.pw_gid==1000,'PGCAL_RUNTIME_UID')
    command(['usermod','-aG','docker',account.pw_name])
    for name in ('work','logs'):command(['chown','1000:1000',ROOT/name])
    # Capture daemon/store and package versions before any source or image import.
    for name,args,legacy in [
        ('bootstrap-packages',['dpkg-query','-W'],'packages.txt'),
        ('docker-version-before-import',['docker','version'],'docker-version.txt'),
        ('docker-info-before-import',['docker','info'],None),
        ('node-version-before-import',['node','--version'],'node-version.txt')]:
        output=logged_command(name,args)
        if legacy:(ROOT/'work'/legacy).write_bytes(output)
    if role=='driver':
        try:existing=pwd.getpwuid(1001)
        except KeyError:command(['useradd','--uid','1001','--user-group','--no-create-home','--shell','/usr/sbin/nologin','nsload'])
        else:need(existing.pw_name=='nsload' and existing.pw_gid==1001,'PGCAL_TRAFFIC_UID')
    for name,identity in [('alignment',spec['helperCommit']),*([('core',spec['pins']['core']),('deploy',spec['pins']['deploy'])] if role=='sut' else [])]:
        repo=ROOT/'alignment' if name=='alignment' else ROOT/'sources'/(name+'.git')
        command(['git','init',*(['--bare'] if name!='alignment' else []),'-q',repo])
        command(['git','-C',repo,'index-pack','--stdin'],input=(ROOT/'input'/(name+'.pack')).read_bytes())
        gitdir=repo/'.git' if name=='alignment' else repo
        (gitdir/'shallow').write_text(identity+'\n')
        command(['git','-C',repo,'update-ref','refs/heads/paired',identity])
        if name=='alignment':
            command(['git','-C',repo,'symbolic-ref','HEAD','refs/heads/paired'])
            command(['git','-C',repo,'sparse-checkout','init','--no-cone'])
            paths=['/tools/mt-bench/remote-pgstream/']+(['/tools/mt-bench/m7-joined/','/tools/mt-bench/capacity/','/tools/mt-bench/compose-baseline/','/tools/queue/gates/m7_joined_receipt.py'] if role=='sut' else [])
            command(['git','-C',repo,'sparse-checkout','set','--no-cone',*paths])
            command(['git','-C',repo,'reset','--hard',identity])
        command(['chown','-R','1000:1000',repo])
    if role=='sut':
        for name in ('app','postgres'):
            image=spec['archives'][name];file=ROOT/'input'/(name+'.tar')
            need(digest(file)==image['sha256'],'PGCAL_ARCHIVE_BYTES')
            logged_command(name+'-image-load',['docker','load','-i',file],1800)
            inspected=logged_command(name+'-image-inspect',['docker','image','inspect','--format','{{.Id}}',image['imageId']])
            need(inspected.decode().strip()==image['imageId'],'PGCAL_IMAGE_ID')
        for image in ['hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2','nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10']:
            command(['docker','pull',image],600)
    else:
        command(['docker','pull',spec['k6Image']],600)
        fresh_k6_version(spec)

# This profile's genuine registry manifest/config proof selects exactly this binary.
K6_VERSION_REFERENCE='grafana/k6@sha256:a90b459a3768c46ad1013da53af24189f735d7112273c6ac3212ca8ed0e18656'
K6_VERSION_IMAGE='sha256:eeb0db19cd8d263aa57346cdbc7ea18e6fcfb2ba9497746a7ae82ceefc8c9fa5'

def _version_actor(reference):
    by_id=re.fullmatch('[a-f0-9]{64}',reference)is not None
    selector='id='+reference if by_id else'name=^/'+reference+'$'
    ids=command(['docker','ps','-aq','--no-trunc','--filter',selector],10).decode().split()
    if not ids:return None
    need(len(ids)==1 and re.fullmatch('[a-f0-9]{64}',ids[0])is not None and(not by_id or ids[0]==reference),'PGCAL_K6_VERSION_FULL_CID')
    rows=json.loads(command(['docker','inspect',ids[0]],10));need(len(rows)==1 and rows[0].get('Id')==ids[0],'PGCAL_K6_VERSION_INSPECT')
    return rows[0]

def _qualify_version_actor(row,intent):
    cfg=row['Config'];host=row['HostConfig'];labels=cfg.get('Labels')or{}
    need(row.get('Name')=='/'+intent['name'] and labels.get('org.nightscout.external.owner')==intent['nonce'] and labels.get('org.nightscout.external.kind')=='k6-version','PGCAL_K6_VERSION_OWNER')
    need(row['Image']==intent['imageId'] and cfg.get('Image')==intent['image'] and cfg.get('Cmd')==['version'] and cfg.get('Entrypoint')==intent['entrypoint'],'PGCAL_K6_VERSION_IMAGE_COMMAND')
    import datetime
    need(datetime.datetime.fromisoformat(row['Created'].replace('Z','+00:00')).timestamp()>=intent['notBefore'],'PGCAL_K6_VERSION_STALE')
    need(not row.get('Mounts') and cfg.get('Env',[])==intent['environment'] and cfg.get('User')=='1001:1001' and host.get('NetworkMode')=='none' and host.get('ReadonlyRootfs')is True and host.get('Privileged')is False and host.get('CapDrop')==['ALL'] and host.get('CapAdd')in(None,[]) and host.get('Devices')in(None,[]) and host.get('PidMode')=='' and host.get('IpcMode')=='private' and host.get('AutoRemove')is True and host.get('SecurityOpt')==['no-new-privileges'],'PGCAL_K6_VERSION_SECURITY')
    return row['Id']

def _cleanup_version_actor(intent,cidfile):
    # Capture is supplemental. Inspect CID and planned name independently, clean
    # only qualified owned rows, then retain any capture contradiction as failure.
    first_error=None;removed=[];owned={}
    try:cid=cidfile.read_text().strip()if cidfile.exists()else None
    except OSError:cid=None
    valid_cid=cid if re.fullmatch('[a-f0-9]{64}',cid or'')else None
    for reference in ([valid_cid]if valid_cid else[])+[intent['name']]:
        try:
            row=_version_actor(reference)
            if row is None:continue
            actual=_qualify_version_actor(row,intent);owned[actual]=row
            if valid_cid and actual!=valid_cid:raise RuntimeError('PGCAL_K6_VERSION_CID_CHANGED')
        except BaseException as error:
            if first_error is None:first_error=error
    for actual in owned:
        try:
            command(['docker','rm','--force',actual],30)
            need(_version_actor(actual)is None,'PGCAL_K6_VERSION_REMAINS');removed.append(actual)
        except BaseException as error:
            if first_error is None:first_error=error
    try:
        row=_version_actor(intent['name'])
        if row is not None:
            _qualify_version_actor(row,intent)
            raise RuntimeError('PGCAL_K6_VERSION_REMAINS')
    except BaseException as error:
        if first_error is None:first_error=error
    evidence={'status':'EXACT_VERSION_ACTOR_ABSENT'if first_error is None else'VERSION_CAPTURE_OR_CLEANUP_REFUSED','cid':valid_cid,'removedOwnedIds':removed,'capture':'CIDFILE'if valid_cid else'NAME_FALLBACK_OR_NO_CREATION'}
    if first_error is not None:
        first_error.cleanupEvidence=evidence
        raise first_error
    return evidence


def fresh_k6_version(spec):
    """Inert owned binary proof after pull, before any SUT prepare or traffic."""
    need(spec['k6Image']==K6_VERSION_REFERENCE and re.fullmatch('[a-f0-9]{32}',spec.get('nonce',''))is not None,'PGCAL_K6_VERSION_SOURCE')
    folder=ROOT/'work';intentfile=folder/'k6-version-intent.json';cidfile=folder/'k6-version.cid';proof=folder/'k6-version-proof.json'
    need(not intentfile.exists()and not cidfile.exists()and not proof.exists(),'PGCAL_K6_VERSION_ATTEMPT_EXISTS')
    metadata=json.loads(logged_command('k6-version-image',['docker','image','inspect',spec['k6Image']],30))
    need(len(metadata)==1 and metadata[0].get('Id')==K6_VERSION_IMAGE and metadata[0].get('Architecture')=='amd64' and metadata[0].get('Os')=='linux' and spec['k6Image']in metadata[0].get('RepoDigests',[]),'PGCAL_K6_VERSION_CONFIG_ID')
    image=metadata[0];name='nsversion-'+spec['nonce'][:12]
    need(_version_actor(name)is None,'PGCAL_K6_VERSION_NAME_EXISTS')
    argv=['docker','run','--rm','--name',name,'--cidfile',str(cidfile),'--network','none','--user','1001:1001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--label','org.nightscout.external.owner='+spec['nonce'],'--label','org.nightscout.external.kind=k6-version',spec['k6Image'],'version']
    intent={'name':name,'nonce':spec['nonce'],'image':spec['k6Image'],'imageId':image['Id'],'entrypoint':image['Config'].get('Entrypoint'),'environment':image['Config'].get('Env',[]),'notBefore':time.time(),'argv':argv}
    write(intentfile,intent);failure=None;cleanup_error=None;cleanup=None;version=None
    try:
        raw=logged_command('k6-version',argv,60)
        need(len(raw)<=16384,'PGCAL_K6_VERSION_OUTPUT_BOUND');version=raw.decode('utf8').strip()
        need(re.match(r'^k6 v1\.3\.0(?:[+ (]|$)',version)is not None,'PGCAL_K6_VERSION_MISMATCH')
        need(cidfile.exists()and re.fullmatch('[a-f0-9]{64}',cidfile.read_text().strip())is not None,'PGCAL_K6_VERSION_CID_MISSING')
    except BaseException as error:
        failure=error;raise
    finally:
        try:cleanup=_cleanup_version_actor(intent,cidfile)
        except BaseException as error:
            cleanup_error=error;cleanup=getattr(error,'cleanupEvidence',None)
            if failure is None:raise
        finally:
            write(proof,{'status':'FRESH_K6_VERSION_PASS'if failure is None and cleanup_error is None else'FAIL','image':spec['k6Image'],'configImageId':image['Id'],'version':version,'commandSeconds':60,'network':'none','cleanup':cleanup,'failureType':type(failure).__name__ if failure else None,'failureCode':str(failure)if isinstance(failure,RuntimeError)else None,'cleanupError':str(cleanup_error)if cleanup_error else None,'scope':'Actual fresh driver binary execution and registry/config binding; no workload or capacity acceptance'})
    return read(proof)

def capture_role_logs():
    """Optional bounded existing logs, retained before teardown and evidence tar."""
    cell=ROOT/'work/cell'
    if not (cell/'owner.json').is_file():return
    target=cell/'role-logs';target.mkdir(mode=0o700,exist_ok=True)
    try:
        import app
        a=app.a;m=a.document(cell/'owner.json');a.assert_owned(m)
        before=a.resources(m)
        selected={name:value for name,value in a.document(cell/'frozen.compose.json')['services'].items()
                  if name in ('api','evaluator','realtime','admin','tenant-admin','vcpool')}
        captured=a.profile_provenance.capture_logs(target,{'services':selected},
            lambda role:['docker','logs','--tail','1000',next(row['Id'] for row in before if row['Config']['Labels'].get('com.docker.compose.service')==role)],
            seconds=1,per_role=1048576,total=6291456)
        for row in captured.get('roles',[]):
            file=target/(row['role']+'.log')
            if file.is_file():row['logSha256']=digest(file)
        after=a.resources(m)
        incarnation=lambda rows:{row['Id']:{'imageId':row['Image'],'startedAt':row['State']['StartedAt'],
            'service':row['Config']['Labels'].get('com.docker.compose.service'),'owner':row['Config']['Labels'].get(a.OWNER)}for row in rows}
        write(target/'containers.before.private.json',before);write(target/'containers.after.private.json',after)
        write(target/'capture.json',{'status':'CAPTURED' if incarnation(before)==incarnation(after) else 'UNMEASURED_IDENTITY_CHANGED',
            'owner':m['owner'],'hostIdentity':m.get('hostIdentity'),'pair':m['pair'],'imageId':m['imageId'],
            'instrument':m['instrument'],'incarnations':incarnation(before),'capture':captured,
            'scope':'bounded retained per-container logs; missing/truncated rows or incomplete phase bookends remain UNMEASURED'})
    except Exception as error:
        write(target/'capture.json',{'status':'UNMEASURED','reason':type(error).__name__})

def action_main():
    action=sys.argv[1];role=sys.argv[2] if len(sys.argv)>2 else None
    if action=='bind-host':return print(json.dumps(bind_host(role)))
    spec=context(action in ('collect','down'),role=role,action=action)
    if action=='bootstrap':return bootstrap(spec,role)
    sys.path.insert(0,str(helper()))
    if action=='prepare':
        args=prepare_arguments(spec,prepare_diagnostic_dependencies(spec))
        sys.stdout.buffer.write(worker(args));return
    if action=='port':return print(json.dumps({'port':read(ROOT/'work/cell/owner.json')['port']}))
    if action=='admit':
        import protocol,transport,host_binding
        host_binding.preflight(ROOT/'work/cell')
        b=protocol.binding(read(ROOT/'input/binding.json'));transport.owned_nic(b,transport.local_nics())
        chain,rules=transport.firewall_rules(b)
        command(['iptables','-t','raw','-N',chain])
        # Build the closed chain before publishing its first jump.
        import shlex
        for rule in rules[1:]:command(['iptables','-t','raw',*shlex.split(rule)])
        jump=shlex.split(rules[0]);command(['iptables','-t','raw','-I','PREROUTING','1',*jump[2:]])
        # sudo has no controller environment and only reads local table state.
        saved=logged_command('firewall-admission',['iptables-save','-t','raw'],10).decode()
        transport.firewall_check(b,saved);return
    if action=='session':
        account=pwd.getpwuid(1000)
        os.execvp('setpriv',['setpriv','--reuid','1000','--regid','1000','--init-groups','env','-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME='+account.pw_dir,'LANG=C.UTF-8','DOCKER_HOST=unix:///var/run/docker.sock',*map(str,cellargs('session'))])
    if action in ('deploy','export'):
        sys.stdout.buffer.write(worker(cellargs(action),2400 if action=='deploy' else 1800));return
    if action=='generator-session':
        soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
        wanted=spec['driverLimits'].get('requestedWorkerFdSoft',soft)
        need(type(wanted) is int and wanted>=8192 and (hard==resource.RLIM_INFINITY or hard>=wanted),'PGCAL_DRIVER_FD_LIMIT')
        resource.setrlimit(resource.RLIMIT_NOFILE,(wanted,hard))
        write(ROOT/'work/driver-fd-launch.json',{'observedBefore':{'soft':soft,'hard':hard},'requestedWorkerFdSoft':spec['driverLimits'].get('requestedWorkerFdSoft'),'soft':resource.getrlimit(resource.RLIMIT_NOFILE)[0],'hard':resource.getrlimit(resource.RLIMIT_NOFILE)[1],'scope':'trusted generator process inherited by probe; k6 container limit separately unmeasured'})
        os.execv(sys.executable,[sys.executable,str(helper()/'generator.py'),'--directory',str(ROOT/'traffic'),'--binding',str(ROOT/'input/binding.json')])
    if action=='client-export':
        export_client_results(spec);return
    if action=='client-import':
        import_client_results(spec);return
    if action=='collect':
        capture_role_logs()
        file=ROOT/'evidence.tar.gz'
        command(['timeout','18','tar','--exclude=*/core','--exclude=*/dependencies','--exclude=*/state','--exclude=*.pack','--exclude=*.tar','-czf',file,'-C',ROOT,*[name for name in ('work','logs','traffic') if (ROOT/name).is_dir()]],25)
        os.chown(file,1000,1000);file.chmod(0o600);return
    if action=='down':
        if (ROOT/'work/cell/owner.json').is_file():sys.stdout.buffer.write(worker(cellargs('down'),300))
        if role=='driver':
            import generator
            generator.cleanup_actors(ROOT/'traffic',read(ROOT/'input/binding.json'))
        return
    raise RuntimeError('PGCAL_ACTION')
def client_result_paths(spec, importing=False):
    from component_cases import plan,result_names
    cases=plan(spec['componentCases'],spec['tenants'])['cases'] if spec.get('componentCases') else None
    names=result_names(cases) if cases else RESULTS
    result={}
    for name in names:
        if importing:
            result[name]=ROOT/'work/cell'/('components/generator-provenance.json' if cases and name=='generator-provenance.json' else ('/'.join(name.split('/')[:-1])+'/load/'+name.split('/')[-1] if cases else 'load/'+name))
        elif cases:
            result[name]=ROOT/'traffic'/('generator-provenance.json' if name=='generator-provenance.json' else '/'.join(name.split('/')[:-1])+'/load/'+name.split('/')[-1])
        else:
            relative={'generator-provenance.json':'generator-provenance.json','generator-metrics.json':'control/generator-metrics.json','k6-launch.json':'control/k6-launch.json','generator-processes.json':'control/processes.json','generator-public-result.json':'control/public-result.json'}.get(name,'load/'+name)
            result[name]=ROOT/'traffic'/relative
    return result


def export_client_results(spec):
    paths=client_result_paths(spec);missing=[];files={}
    discovery=spec.get('reportMode','strict')=='discovery'
    out=ROOT/'work/client.tar'
    with tarfile.open(out,'x') as tar:
        for name,file in paths.items():
            if not file.exists() and not file.is_symlink():
                need(discovery or name in OPTIONAL_RESULTS,'PGCAL_CLIENT_RESULT_BOUND');missing.append(name);continue
            need(file.is_file() and not file.is_symlink() and file.stat().st_size<=32*1024*1024,'PGCAL_CLIENT_RESULT_BOUND')
            files[name]=digest(file);tar.add(file,arcname=name,recursive=False)
        receipt=ROOT/'work/client-result-manifest.json'
        write(receipt,{'version':1,'files':files,'missing':missing,'reportMode':spec.get('reportMode','strict')})
        tar.add(receipt,arcname='client-result-manifest.json',recursive=False)
    os.chown(out,1000,1000);out.chmod(0o600)


def import_client_results(spec):
    paths=client_result_paths(spec,True);mode=spec.get('reportMode','strict')
    with tarfile.open(ROOT/'work/client.tar') as tar:
        members=tar.getmembers();names=[m.name for m in members]
        need(len(names)==len(set(names)) and set(names)<=set(paths)|{'client-result-manifest.json'} and 'client-result-manifest.json' in names and all(m.isfile() and m.size<=32*1024*1024 for m in members),'PGCAL_CLIENT_ARCHIVE_ALLOWLIST')
        receipt_member=tar.getmember('client-result-manifest.json');need(receipt_member.size<=65536,'PGCAL_CLIENT_ARCHIVE_ALLOWLIST')
        receipt=json.load(tar.extractfile(receipt_member))
        need(receipt.get('version')==1 and receipt.get('reportMode')==mode and isinstance(receipt.get('files'),dict) and isinstance(receipt.get('missing'),list) and len(receipt['missing'])==len(set(receipt['missing'])),'PGCAL_CLIENT_ARCHIVE_MANIFEST')
        need(set(receipt['files'])==set(names)-{'client-result-manifest.json'} and set(receipt['missing'])==set(paths)-set(receipt['files']) and (mode=='discovery' or set(receipt['missing'])<=OPTIONAL_RESULTS),'PGCAL_CLIENT_ARCHIVE_MANIFEST')
        need(not (ROOT/'work/cell/load/generator-result-manifest.json').exists() and not (ROOT/'work/cell/load/generator-result-manifest.json').is_symlink(),'PGCAL_RESULT_EXISTS')
        # Validate all bytes before writing any imported artifact.
        for name,expected in receipt['files'].items():
            need(hashlib.sha256(tar.extractfile(name).read()).hexdigest()==expected,'PGCAL_CLIENT_ARCHIVE_HASH')
        for name in receipt['files']:
            dest=paths[name];need(not dest.exists() and not dest.is_symlink(),'PGCAL_RESULT_EXISTS')
            with dest.open('xb') as f:f.write(tar.extractfile(name).read())
            os.chown(dest,1000,1000);dest.chmod(0o600)
        manifest=ROOT/'work/cell/load/generator-result-manifest.json'
        descriptor=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        with os.fdopen(descriptor,'w',encoding='utf-8') as stream:
            json.dump(receipt,stream,sort_keys=True);stream.write('\n');stream.flush()
            os.fchown(stream.fileno(),1000,1000);os.fchmod(stream.fileno(),0o600)


def main():
    action=sys.argv[1] if len(sys.argv)>1 else None
    if action in ('bind-host','bootstrap','prepare','port','admit','deploy','export'):
        with cold_setup(read(ROOT/'input/spec.json')):return action_main()
    return action_main()

if __name__=='__main__':main()
