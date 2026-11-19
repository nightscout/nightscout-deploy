#!/usr/bin/env node
'use strict';

// Invariants of the rendered Kubernetes binding. Offline: renders with `tk eval`, reads no
// cluster.
//
//   node check/invariants.js [--root <tanka root>] [--env environments/preview] [--compose <bindings/compose dir>]
//
// Prints one line per check, `ok   <check>` or `FAIL <check>: <reason>`, and exits 1 on any failure.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');

function args (argv) {
  const out = { root: path.resolve(__dirname, '..'), env: 'environments/synthetic', compose: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['root', 'env', 'compose'].includes(key) || argv[i + 1] === undefined) throw new Error('usage: invariants.js [--root dir] [--env path] [--compose dir]');
    out[key] = argv[i + 1];
  }
  out.root = path.resolve(out.root);
  out.compose = path.resolve(out.compose || path.join(out.root, '..', 'compose'));
  return out;
}

function tk (root, env, extra = []) {
  const inputs=['NS_SOURCE_COMMIT','NS_DEMO_IMAGE','NS_PGSTREAM_POSTGRES_IMAGE'];
  if (env.includes('preview')) for(const key of inputs)if(!process.env[key])throw new Error(key+' must name the explicit supplied artifact input');
  try { return JSON.parse(execFileSync('tk', ['eval', env, ...inputs.filter(key=>process.env[key]).flatMap(key=>['--ext-str',key+'='+process.env[key]]), ...extra], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })); }
  catch (error) {
    if (error.stderr) throw new Error(String(error.stderr).trim());
    throw error;
  }
}

function manifests (value, out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.apiVersion === 'string' && typeof value.kind === 'string') out.push(value);
    else for (const child of Object.values(value)) manifests(child, out);
  }
  return out;
}

const WORKLOADS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'];
function podSpec (m) {
  if (m.kind === 'Pod') return m.spec;
  if (m.kind === 'CronJob') return m.spec.jobTemplate.spec.template.spec;
  return m.spec.template.spec;
}
function podLabels (m) {
  if (m.kind === 'Pod') return m.metadata.labels || {};
  if (m.kind === 'CronJob') return m.spec.jobTemplate.spec.template.metadata.labels || {};
  const labels=(m.spec.template.metadata || {}).labels || {};
  return m.kind==='StatefulSet'&&m.spec.replicas===1?{...labels,'statefulset.kubernetes.io/pod-name':m.metadata.name+'-0'}:labels;
}
const containersOf = spec => [...(spec.initContainers || []), ...(spec.containers || [])];
const id = m => m.kind + '/' + m.metadata.name;
const selects = (selector, labels) => !!selector && Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels[k] === v);

function checks (all, inventory, composeDir, envMain) {
  const workloads = all.filter(m => WORKLOADS.includes(m.kind));
  const services = all.filter(m => m.kind === 'Service');
  const results = [];
  const run = (name, fn) => {
    const failures = [];
    try { fn(msg => failures.push(msg)); } catch (error) { failures.push('check raised: ' + error.message); }
    results.push({ name, failures });
  };
  // Container ports of the Pods a Service selects, by name and number.
  const targets = svc => {
    const out = [];
    for (const w of workloads) {
      if (!selects(svc.spec.selector, podLabels(w))) continue;
      for (const c of containersOf(podSpec(w))) for (const p of c.ports || []) out.push({ workload: w, container: c.name, port: p });
    }
    return out;
  };
  const resolve = (svc, sp) => targets(svc).filter(t => t.port.name === sp.targetPort || t.port.containerPort === (sp.targetPort ?? sp.port));

  run('edge-configuration', fail => {
    const source=fs.readFileSync(path.join(__dirname,'../assets/nginx.conf'),'utf8');
    const maps=all.filter(m=>m.kind==='ConfigMap'&&m.metadata.name==='edge-nginx');
    let projected=source;
    if(Object.hasOwn(inventory,'edgeConfiguration')) {
      const c=inventory.edgeConfiguration,r=c?.requested,fields=['workerProcesses','workerConnections'];
      if(!r || typeof r!=='object' || Array.isArray(r) || !Object.keys(r).length || Object.keys(r).some(k=>!fields.includes(k)) ||
          Object.entries(r).some(([k,v])=>!Number.isSafeInteger(v)||v<1||(k==='workerProcesses'&&v>1024))) { fail('EDGE_CONFIGURATION'); return; }
      const expected={requested:r,effective:{workerProcesses:r.workerProcesses??'auto',workerConnections:r.workerConnections??1024},sourceAsset:'assets/nginx.conf',descriptorLimit:'INHERITED_OS_UNMEASURED'};
      if(!require('node:util').isDeepStrictEqual(c,expected))fail('EDGE_INVENTORY_CHANGED');
      if(['worker_processes','worker_connections','worker_processes auto;','worker_connections 1024;'].some(s=>source.split(s).length!==2)) { fail('EDGE_SOURCE_SHAPE'); return; }
      if(Object.hasOwn(r,'workerProcesses'))projected=projected.replace('worker_processes auto;','worker_processes '+r.workerProcesses+';');
      if(Object.hasOwn(r,'workerConnections'))projected=projected.replace('worker_connections 1024;','worker_connections '+r.workerConnections+';');
    }
    if(maps.length!==1 || !require('node:util').isDeepStrictEqual(maps[0].data,{'nginx.conf':projected}) || maps[0].binaryData)fail('EDGE_CONFIGMAP_CHANGED');
  });

  run('independent-pgstream', fail => {
    const streams=workloads.filter(w=>(podSpec(w).containers||[]).some(c=>c.name==='pgstream'));
    if(streams.length!==1)return fail('exactly one pgstream workload required');
    const stream=streams[0],spec=podSpec(stream),container=spec.containers.find(c=>c.name==='pgstream');
    if(stream.kind!=='Deployment'||stream.spec.replicas!==1||stream.spec.strategy?.type!=='Recreate')fail('pgstream must be a one-replica Recreate Deployment');
    if(JSON.stringify(container.command)!==JSON.stringify(['/usr/local/bin/pgstream','run','-c','/run/ns-stream/pgstream.yaml','--log-level','info']))fail('pgstream must run the maintained binary directly');
    const volume=(spec.volumes||[]).find(v=>v.name==='secret-pgstream');
    if(volume?.secret?.secretName!=='ns-config-pgstream'||!(container.volumeMounts||[]).some(v=>v.name==='secret-pgstream'&&v.mountPath==='/run/ns-stream'&&v.readOnly))fail('pgstream requires its dedicated wire Secret');
    for(const w of workloads)if(w!==stream&&(podSpec(w).volumes||[]).some(v=>v.secret?.secretName==='ns-config-pgstream'))fail('streaming wire credentials must not be mounted in the evaluator or another workload');
    const intake=services.find(v=>v.metadata.name==='evaluator');
    if(!intake||intake.spec.type!=='ClusterIP'||intake.spec.selector?.['app.kubernetes.io/component']!=='evaluator')fail('intake Service must select the evaluator');
    if(intake?.spec.publishNotReadyAddresses!==true)fail('intake routing must bypass pod-wide clinical readiness to avoid a stream startup cycle');
    if(intake&&!intake.spec.ports?.some(p=>p.port===19913&&p.targetPort==='stream-intake'))fail('intake Service must target the declared receiver port');
    const postgres=workloads.find(w=>w.metadata.name==='postgres'),command=(podSpec(postgres).containers.find(c=>c.name==='postgres').args||[]);
    for(const setting of ['wal_level=logical','max_replication_slots=4','max_wal_senders=4','max_slot_wal_keep_size=-1','output_plugin_libraries=wal2json'])if(!command.includes(setting))fail('PostgreSQL is missing maintained streaming setting '+setting);
  });

  run('evaluator-statefulset', fail => {
    // Decision statefulset-ordinal-scaling: the evaluator is a StatefulSet held at K=1 (one
    // pgstream receiver); evaluator K>1 is not supported by this binding.
    const hosts = workloads.filter(w => (podSpec(w).containers || []).some(c => c.name === 'evaluator'));
    if (hosts.length !== 1) return fail('the evaluator must run in exactly one workload, found ' + hosts.length);
    const w = hosts[0];
    if (w.kind !== 'StatefulSet' || w.spec.replicas !== 1) fail(id(w) + ' must be a one-replica StatefulSet');
    const container = podSpec(w).containers.find(c => c.name === 'evaluator');
    const probe = JSON.stringify(container.readinessProbe || {});
    if (probe !== JSON.stringify({ exec: { command: ['node', 'deploy/multitenant/health.js', 'evaluator'] }, failureThreshold: 30, periodSeconds: 2, timeoutSeconds: 3 })) fail('evaluator readiness must be the role health check only');
  });

  run('realtime-slices', fail => {
    // Realtime slice = pod index, K = NS_SLICE_COUNT, both from the one `slices.realtime` value.
    const w = workloads.find(x => x.kind === 'StatefulSet' && x.metadata.name === 'realtime');
    if (!w) return fail('realtime must be a StatefulSet');
    const env = Object.fromEntries((podSpec(w).containers.find(c => c.name === 'realtime').env || []).map(e => [e.name, e]));
    if (env.NS_SLICE_COUNT?.value !== String(w.spec.replicas) || w.spec.replicas !== inventory.slices.realtime) fail('NS_SLICE_COUNT and replicas must both be slices.realtime');
    if (env.NS_SLICE_ORDINAL?.valueFrom?.fieldRef?.fieldPath !== "metadata.labels['apps.kubernetes.io/pod-index']") fail('NS_SLICE_ORDINAL must come from the pod-index label');
  });

  run('startup-budget', fail => {
    // Compose gives api, realtime and evaluator start_period 900s; the binding's startupProbe on the
    // same health command must allow at least as long, so readiness is not judged during a warm.
    for (const role of ['api', 'realtime', 'evaluator']) {
      const hosts = workloads.flatMap(w => (podSpec(w).containers || []).filter(c => c.name === role).map(c => [w, c]));
      if (!hosts.length) fail('no container named ' + role);
      for (const [w, c] of hosts) {
        const p = c.startupProbe;
        if (!p) { fail(id(w) + ' container ' + role + ' has no startupProbe'); continue; }
        const want = JSON.stringify(['node', 'deploy/multitenant/health.js', role]);
        if (JSON.stringify((p.exec || {}).command) !== want) fail(id(w) + ' container ' + role + ' startupProbe must run the role health check ' + want);
        const budget = (p.periodSeconds || 10) * (p.failureThreshold || 3);
        if (budget < 900) fail(id(w) + ' container ' + role + ' startupProbe allows ' + budget + ' s; it must allow at least 900 s (Compose start_period)');
      }
    }
  });

  run('no-overlap-update', fail => {
    // Deployments replace by Recreate. StatefulSets use the ordinary rolling update; a realtime
    // K change is one (decision statefulset-ordinal-scaling).
    for (const w of workloads) if (w.kind === 'Deployment' && (w.spec.strategy || {}).type !== 'Recreate') fail(id(w) + ' strategy must be Recreate (a RollingUpdate overlaps old and new Pods)');
  });

  run('private-directories', fail => {
    // An emptyDir root is root-owned 3777 under fsGroup; core refuses it as the socket directory
    // (transport.js SOCKET_IPC_DIRECTORY_REFUSED). Role containers mount the 0700 subdirectory.
    for (const w of workloads) for (const c of (podSpec(w).containers || [])) for (const vm of c.volumeMounts || []) {
      if ((vm.name === 'ns-ipc' || /^config-/.test(vm.name)) && vm.subPath !== 'd') fail(id(w) + ' container ' + c.name + ' mounts ' + vm.name + ' at its root; mount the 0700 subdirectory (subPath d)');
    }
  });

  run('service-links-off', fail => {
    for (const w of workloads) if (podSpec(w).enableServiceLinks !== false) fail(id(w) + ' must set enableServiceLinks: false (Service links inject <SERVICE>_PORT=tcp://... and collide with API_PORT/REALTIME_PORT/ADMIN_PORT)');
  });

  run('admin-vault-trust', fail => {
    const admin = workloads.find(w => w.metadata.name === 'admin');
    const spec = podSpec(admin), container = spec.containers.find(c => c.name === 'admin');
    if (!(container.env || []).some(e => e.name === 'NODE_EXTRA_CA_CERTS' && e.value === '/run/ns-ca/ca.crt')) fail('source admin must load the exact Vault CA before Node startup');
    if (!(container.volumeMounts || []).some(v => v.name === 'ns-ca' && v.mountPath === '/run/ns-ca' && v.readOnly === true) || !(spec.volumes || []).some(v => v.name === 'ns-ca' && v.secret?.secretName === 'ns-ca')) fail('source admin requires the read-only namespace Vault CA mount');
  });

  run('admin-vault-provisioning-network', fail => {
    const policy = all.find(m => m.kind === 'NetworkPolicy' && m.metadata.name === 'vault-from-app');
    const allowed = (policy?.spec.ingress || []).some(rule => (rule.ports || []).some(p => p.port === 8200 && p.protocol === 'TCP') && (rule.from || []).some(peer => peer.podSelector?.matchLabels?.['app.kubernetes.io/component'] === 'admin'));
    if (!allowed) fail('source admin provisioning requires Vault TCP8200 ingress');
  });

  run('postgres-identities-match-compose', fail => {
    const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/source-contract.json')));
    for (const [role, names] of Object.entries(contract.postgresIdentities)) {
      const want=[...names].sort(), have=[...(inventory.postgresIdentities[role]||[])].sort();
      if (JSON.stringify(want)!==JSON.stringify(have)) fail(role+': binding names '+have.join(',')+', Compose names '+want.join(','));
    }
  });

  run('source-command-identity', fail => {
    const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/source-contract.json')));
    for (const w of workloads) for (const c of containersOf(podSpec(w))) {
      if (['install-config','wait-stores','vault-kubernetes-auth','done','vault-agent','postgres','vault','nginx'].includes(c.name)) continue;
      const want=contract.commands[c.name];
      if (want && JSON.stringify(c.command)!==JSON.stringify(want)) fail(c.name+' command differs from source Compose');
      if (c.image!==inventory.images.app) fail(c.name+' image differs from declared immutable application image');
    }
    for (const w of workloads) {
      for (const c of containersOf(podSpec(w))) if (!['postgres','vault','vault-agent','nginx'].includes(c.name) && c.image!==inventory.images.app) fail(c.name+' image differs from declared immutable application image');
      const a=w.metadata.annotations||{};
      if (a['nightscout.org/source-commit']!==inventory.sourceCommit || a['nightscout.org/image-deploy-commit']!==inventory.imageDeployCommit || a['nightscout.org/binding-identity']!==inventory.bindingIdentity) fail(id(w)+' provenance annotations differ from inventory');
    }
    const pg=workloads.find(w=>w.metadata.name==='postgres');
    const p=podSpec(pg).containers.find(c=>c.name==='postgres');
    if(p.command)fail('postgres must retain its image entrypoint for initdb');
    const bootstrap=containersOf(podSpec(workloads.find(w=>w.metadata.name==='provision'))).find(c=>c.name==='bootstrap');
    const env=Object.fromEntries(bootstrap.env.map(e=>[e.name,e.value]));
    if(env.NS_SOURCE_COMMIT!==inventory.sourceCommit || env.NS_DEPLOY_COMMIT!==inventory.imageDeployCommit || env.NS_PGSTREAM!=='1')fail('bootstrap source/producer identity is missing or wrong');
  });

  run('container-budgets', fail => {
    const mode = inventory.resourceAccounting || 'limits-v1';
    if (!['limits-v1','requests-v1'].includes(mode)) { fail('unknown resource accounting'); return; }
    for (const w of workloads) for (const c of containersOf(podSpec(w))) for (const group of ['requests','limits']) {
      for (const key of ['cpu','memory','ephemeral-storage']) {
        const value=c.resources?.[group]?.[key];
        if(mode==='requests-v1' && group==='limits' && value===undefined) continue;
        const positive = mode==='limits-v1' ? value && /^[1-9][0-9]*(m|Mi|Gi)?$/.test(value) :
          value!==undefined && /^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+|[numkKMGTPE]|[KMGTPE]i)?$/.test(String(value)) && parseFloat(value)>0;
        if (!positive) fail(id(w)+' container '+c.name+' missing positive '+group+'.'+key);
      }
    }
  });

  run('existing-capacity-profile', fail => {
    if(inventory.profile!=='existing-capacity')return;
    if(inventory.storage.mode==='dynamic')fail('existing-capacity cannot request dynamic storage');
    for(const m of all) {
      if(['PersistentVolumeClaim','PersistentVolume','StorageClass','Ingress'].includes(m.kind))fail(id(m)+' adds a provider resource');
      if(m.kind==='Service'&&(m.spec.type||'ClusterIP')!=='ClusterIP')fail(id(m)+' must be ClusterIP for existing-capacity');
    }
    for(const w of workloads){
      if(w.spec.volumeClaimTemplates?.length)fail(id(w)+' adds dynamic claims');
      if((podSpec(w).volumes||[]).some(v=>v.hostPath))fail(id(w)+' borrows node storage');
      for (const v of podSpec(w).volumes || []) {
        if (id(w) === 'Job/primer' && v.name === 'client-state') continue;
        if (v.emptyDir && !v.emptyDir.sizeLimit) fail(id(w)+' emptyDir '+v.name+' lacks sizeLimit');
      }
    }
  });

  run('provision-boundary', fail => {
    const job=workloads.find(w=>w.metadata.name==='provision');
    if(job?.spec.backoffLimit!==0||!job?.spec.activeDeadlineSeconds)fail('provision requires no retry and a finite deadline');
    const spec=podSpec(job), names=(spec.initContainers||[]).map(c=>c.name);
    if(names.join(',')!=='wait-stores,bootstrap,vault-kubernetes-auth')fail('provision must use source-owned registry bootstrap followed by Kubernetes auth');
    if((spec.volumes||[]).some(v=>v.name==='ownership-grants'))fail('C2 already owns admin grants; historical overlay is refused');
    const done=spec.containers.find(c=>c.name==='done');
    if (JSON.stringify(done.command) !== JSON.stringify(['node', '/run/ns-overlay/candidate-documents.cjs', 'hold'])) fail('provision must hold private output until explicit export');
    if (containersOf(spec).filter(c => c.volumeMounts.some(v => v.name === 'postgres-password')).map(c => c.name).join() !== 'bootstrap')
      fail('only the SQL bootstrap container may mount the setup credential');
    const primer=workloads.find(w=>w.metadata.name==='primer');
    if(primer?.spec.suspend!==true || primer?.spec.backoffLimit!==0 || !primer?.spec.activeDeadlineSeconds)fail('primer must be an explicit suspended finite no-retry Job');
    const primerSpec = podSpec(primer);
    const verification = workloads.find(w => w.metadata.name === 'verification');
    const verifySpec = verification && podSpec(verification);
    if (!verifySpec || verification.spec.backoffLimit !== 0 || !verification.spec.activeDeadlineSeconds ||
        verifySpec.initContainers.some(c => c.name === 'primer') ||
        !verifySpec.containers.some(c => c.command?.includes('verify')))
      fail('platform verification must complete independently of tenant provisioning');
    if (!primerSpec.containers.some(c => c.readinessProbe?.exec?.command.includes('/run/ns-client/provisioned.json')))
      fail('lab client must retain its private provisioning results until export');
    for (const job of [primerSpec, verifySpec]) {
      if (job?.volumes.some(v => v.secret && v.secret.secretName !== 'ns-config-primer'))
        fail('admin clients mount only their unprivileged source documents');
    }
    const admin = workloads.find(w => w.metadata.name === 'admin');
    const adminSpec = podSpec(admin);
    const adminTargetPaths = adminSpec.volumes.find(v => v.name === 'secret-admin')?.secret.items?.map(item => item.path);
    const targetPaths = ['api', 'evaluator', 'realtime'].flatMap(role => ['config', 'env', 'operation'].map(kind => 'verification/' + role + '.' + kind + '.json'));
    if (!targetPaths.every(name => adminTargetPaths?.includes(name))) fail('admin lacks a private verification target document');
    if (!adminSpec.containers[0].env.some(e => e.name === 'NODE_EXTRA_CA_CERTS') ||
        !adminSpec.containers[0].volumeMounts.some(v => v.name === 'ns-ca')) fail('admin requires the scoped Vault CA mount');
    const sqlPolicy = all.find(m => m.kind === 'NetworkPolicy' && m.metadata.name === 'postgres-from-app');
    const sqlPeers = sqlPolicy.spec.ingress.flatMap(rule => rule.from.map(peer => peer.podSelector?.matchLabels?.['app.kubernetes.io/component']));
    if (sqlPeers.includes('operator')) fail('operator network policy must not admit direct PostgreSQL traffic');
    if (inventory.postgresIdentities.ui?.includes('ui_registry') && !sqlPeers.includes('ui'))
      fail('UI registry identity needs scoped PostgreSQL ingress');
    const installers=workloads.flatMap(w=>(podSpec(w).initContainers||[]).filter(c=>c.name==='install-config'));
    if(installers.some(c=>!JSON.stringify(c.command).includes("!n.startsWith('.')")))fail('installer must copy all source documents including extensionless token files');
  });

  return results;
}

function main () {
  const opts = args(process.argv.slice(2));
  const all = manifests(tk(opts.root, opts.env));
  const inventory = tk(opts.root, opts.env, ['-e', 'inventory']);
  const envMain = { sourceCommit: inventory.sourceCommit };
  const results = checks(all, inventory, opts.compose, envMain);
  let failed = 0;
  for (const r of results) {
    if (!r.failures.length) process.stdout.write('ok   ' + r.name + '\n');
    for (const f of r.failures) { failed++; process.stdout.write('FAIL ' + r.name + ': ' + f + '\n'); }
  }
  process.stdout.write(all.length + ' manifests, ' + results.length + ' checks, ' + failed + ' failures\n');
  process.exitCode = failed ? 1 : 0;
}
if (require.main === module) main();
module.exports = { checks, manifests };
