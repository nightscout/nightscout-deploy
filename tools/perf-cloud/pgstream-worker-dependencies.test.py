"""Opt-in real source/image dependency admission control; never deploys services.

Supply PGCAL_DEPENDENCY_CONTROL_CONFIG, PGCAL_DEPENDENCY_CONTROL_BINDING and
PGCAL_DEPENDENCY_CONTROL_DIRECTORY (new private evidence path). This installs the
exact lockfile through the canonical adapter, exercises real worker argv through
cell.py/adapter.prepare, and preserves red/restored artifacts. Requires UID1000,
qualified local Git/image inputs, npm registry access and read-only Docker access.
With no config, ordinary discovery skips this explicit integration control.
"""
import importlib.util,pathlib,json,subprocess,os,hashlib,sys,time
if not os.environ.get('PGCAL_DEPENDENCY_CONTROL_CONFIG'):
 print('SKIP: real source/image dependency control not selected');sys.exit(0)
assert os.getuid()==os.getgid()==1000
config=pathlib.Path(os.environ['PGCAL_DEPENDENCY_CONTROL_CONFIG']).resolve()
r=pathlib.Path(os.environ['PGCAL_DEPENDENCY_CONTROL_DIRECTORY']).resolve()
c=json.loads(config.read_text());r.mkdir();(r/'work').mkdir();(r/'sources').mkdir();(r/'input').mkdir();(r/'alignment').symlink_to(pathlib.Path(c['roots']['helper']).resolve(),target_is_directory=True)
spec=c['spec'];binding=json.loads(pathlib.Path(os.environ['PGCAL_DEPENDENCY_CONTROL_BINDING']).read_text());(r/'input/binding.json').write_text(json.dumps(binding));(r/'input/receipt.json').write_text(json.dumps(spec['receipt']));s=importlib.util.spec_from_file_location('worker',pathlib.Path(__file__).resolve().with_name('pgstream-worker.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w);w.ROOT=r
for name,source,head in [('core',c['roots']['core'],spec['pins']['core']),('deploy',c['roots']['deploy'],spec['pins']['deploy'])]:
 subprocess.run(['git','clone','--bare','--no-local',source,str(r/'sources'/(name+'.git'))],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
def run(argv):
 q=subprocess.run(list(map(str,argv)),capture_output=True,timeout=1800);(r/'producer.stdout').write_bytes(q.stdout);(r/'producer.stderr').write_bytes(q.stderr);q.check_returncode();return q.stdout
d=w.prepare_diagnostic_dependencies(spec,run=run);(r/'qualified-dependencies.json').write_text(json.dumps(d,indent=2));print('REAL_CANONICAL_DEPENDENCY_PRODUCER_PASS',flush=True)
args=list(map(str,w.prepare_arguments(spec,d)))
# Real cell/adapter negative: remove the genuinely required flag from actual worker argv.
idx=args.index('--generator-dependencies');broken=args[:idx]+args[idx+2:];q=subprocess.run(broken,capture_output=True,timeout=90);(r/'missing-forwarding.stdout').write_bytes(q.stdout);(r/'missing-forwarding.stderr').write_bytes(q.stderr);assert q.returncode!=0 and b'M7_DIAGNOSTIC_DEPENDENCIES_REQUIRED'in q.stderr and not(r/'work/cell').exists();print('ACTUAL_CELL_ADAPTER_MISSING_FORWARDING_RED',flush=True)
# Real dependency provenance refusal; not an argument/parser stub.
bad=list(args);idx=bad.index('--generator-dependency-receipt-sha256');bad[idx+1]='0'*64;q=subprocess.run(bad,capture_output=True,timeout=180);(r/'wrong-receipt.stdout').write_bytes(q.stdout);(r/'wrong-receipt.stderr').write_bytes(q.stderr);assert q.returncode!=0 and b'M7_DEPENDENCY_REUSE_RECEIPT_HASH'in q.stderr and not(r/'work/cell').exists();print('ACTUAL_DEPENDENCY_RECEIPT_RED',flush=True)
q=subprocess.run(args,capture_output=True,timeout=1800);(r/'restored.stdout').write_bytes(q.stdout);(r/'restored.stderr').write_bytes(q.stderr)
if q.returncode:print(q.stderr.decode()[-5000:],flush=True)
q.check_returncode();owner=json.loads((r/'work/cell/owner.json').read_text());assert owner['prepared']and owner['generator']['kind']=='owned-qualified-dependency-copy';assert owner['dependencyReuse']['receiptSha256']==d['sha256'];project=owner['project'];ids=subprocess.check_output(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project],text=True).strip();assert not ids
result={'status':'ACTUAL_WORKER_CELL_ADAPTER_PREPARE_PASS_WITH_NEGATIVE_CONTROLS','basis':'reproduced','prepared':True,'dependencyProvenanceKind':owner['generator']['kind'],'dependencyReceiptSha256':d['sha256'],'tests':['missing-forwarding-red','wrong-receipt-red','restored-real-prepare-pass'],'appActors':0,'runtime':'NOT_RUN','capacity':'UNMEASURED','workerSource':str(pathlib.Path(__file__).resolve().with_name('pgstream-worker.py')),'retainedEvidence':str(r)};(r/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
