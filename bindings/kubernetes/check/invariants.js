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
    if (inventory.slices?.realtime > 1) projected = projected.replace('upstream realtime { server realtime:1339; }', 'upstream realtime { server socket-edge:1343; }');
    if(maps.length!==1 || !require('node:util').isDeepStrictEqual(maps[0].data,{'nginx.conf':projected}) || maps[0].binaryData)fail('EDGE_CONFIGMAP_CHANGED');
  });

  run('admin-not-public', fail => {
    if (all.some(m => m.kind === 'Ingress')) fail('an Ingress is rendered; the consumer entry is the edge Service only');
    for (const svc of services) {
      const type = svc.spec.type || 'ClusterIP';
      const consumer = (svc.metadata.annotations || {})['nightscout.org/consumer-entry'] === 'true';
      for (const sp of svc.spec.ports || []) {
        for (const t of resolve(svc, sp)) {
          if (t.port.name !== 'int-admin' && t.port.containerPort !== 1342) continue;
          if (type !== 'ClusterIP') fail('Service/' + svc.metadata.name + ' exposes the admin port as ' + type);
          if (consumer) fail('Service/' + svc.metadata.name + ' is the consumer entry and exposes the admin port');
          if (svc.metadata.name !== 'admin') fail('Service/' + svc.metadata.name + ' exposes the admin port; only Service/admin may');
        }
      }
      if (type !== 'ClusterIP' && !consumer) fail('Service/' + svc.metadata.name + ' is ' + type + ' but is not the consumer entry');
    }
    const nginx = all.find(m => m.kind === 'ConfigMap' && m.metadata.name === 'edge-nginx');
    if (!nginx) fail('edge nginx ConfigMap missing');
    else if (/\badmin\b\s*:|:1342\b|tenant-admin|:1341\b/.test(nginx.data['nginx.conf'].replace(/location[^{]*\{\s*return 404;\s*\}/g, ''))) fail('the edge nginx.conf routes to the admin or owner plane');
    const adminPods = workloads.filter(w => containersOf(podSpec(w)).some(c => (c.ports || []).some(p => p.name === 'int-admin')));
    for (const w of adminPods) {
      const pols = all.filter(m => m.kind === 'NetworkPolicy' && Object.keys(m.spec.podSelector.matchLabels || {}).length && selects(m.spec.podSelector.matchLabels, podLabels(w)));
      if (!pols.length) fail(id(w) + ' has no NetworkPolicy of its own; the namespace default would be its only boundary');
      for (const p of pols) for (const rule of p.spec.ingress || []) {
        const from = rule.from || [];
        if (!from.length || from.some(f => f.ipBlock || f.namespaceSelector || (f.podSelector || {}).matchLabels?.['app.kubernetes.io/component'] !== 'operator')) fail('NetworkPolicy/' + p.metadata.name + ' admits more than operator Pods to the admin plane');
      }
    }
  });

  run('secrets-by-reference', fail => {
    const SECRET_NAME = /^(?!.*_(TTL|FILE|PATH|ENV|DIR)$).*(PASSWORD|TOKEN|SECRET|CREDENTIAL|PRIVATE)|_PG$|^NS_VAULT_[0-9]+$/;
    const SECRET_VALUE = [/[a-z]+:\/\/[^\s/:@]+:[^\s@]+@/i, /\bhvs\.[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
    for (const m of all) if (m.kind === 'Secret') fail('Secret/' + m.metadata.name + ' is rendered; Secrets are created at apply time, never committed');
    for (const m of all.filter(m => m.kind === 'ConfigMap')) {
      for (const [k, v] of Object.entries(m.data || {})) if (SECRET_VALUE.some(re => re.test(v))) fail('ConfigMap/' + m.metadata.name + ' key ' + k + ' holds credential material');
    }
    for (const w of workloads) {
      const spec = podSpec(w);
      for (const c of containersOf(spec)) {
        for (const e of c.env || []) {
          if (e.value !== undefined && (SECRET_NAME.test(e.name) || SECRET_VALUE.some(re => re.test(e.value)))) fail(id(w) + ' container ' + c.name + ' env ' + e.name + ' is a literal; it must come from a Secret reference');
          if (e.valueFrom && e.valueFrom.configMapKeyRef && SECRET_NAME.test(e.name)) fail(id(w) + ' container ' + c.name + ' env ' + e.name + ' comes from a ConfigMap');
        }
        for (const f of c.envFrom || []) if (!f.secretRef) fail(id(w) + ' container ' + c.name + ' envFrom must be a secretRef');
        for (const vm of c.volumeMounts || []) {
          const vol = (spec.volumes || []).find(v => v.name === vm.name);
          if (/^\/run\/(ns-secret|secrets)(\/|$)/.test(vm.mountPath) && !(vol && vol.secret)) fail(id(w) + ' container ' + c.name + ' mounts ' + vm.mountPath + ' from a non-Secret volume ' + vm.name);
        }
      }
      for (const v of spec.volumes || []) if (/^secret-/.test(v.name) && !v.secret) fail(id(w) + ' volume ' + v.name + ' is named as private documents but is not a Secret');
    }
  });

  run('images-pinned', fail => {
    const DIGEST = /@sha256:[0-9a-f]{64}$/;
    const EXACT = /:(v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|[0-9a-f]{40})$/;
    for (const w of workloads) for (const c of containersOf(podSpec(w))) {
      if (typeof c.image !== 'string' || !(DIGEST.test(c.image) || EXACT.test(c.image))) fail(id(w) + ' container ' + c.name + ' image ' + c.image + ' is not pinned by digest or exact tag');
    }
  });

  run('writer-driven-input', fail => {
    const streams=workloads.filter(w=>(podSpec(w).containers||[]).some(c=>c.name==='pgstream'));
    if (inventory.inputTransport !== 'writer-driven') fail('writer-driven is the only input transport');
    if (streams.length || inventory.documents.pgstream) fail('writer-driven input must omit pgstream');
    const evaluator = services.find(v => v.metadata.name === 'evaluator');
    if (evaluator?.spec.clusterIP !== 'None' || !evaluator.spec.ports.some(p => p.port === 19002 && p.targetPort === 'int-role')) fail('writer hints require the private ordinal evaluator Service');
    const postgres = workloads.find(w => w.metadata.name === 'postgres');
    if (podSpec(postgres).containers.find(c => c.name === 'postgres').args.some(x => /wal_level=logical|wal2json/.test(x))) fail('writer-driven input must omit logical decoding');
    for (const role of ['api', 'evaluator', 'realtime', 'tenant-admin']) {
      const workload = workloads.find(w => w.metadata.name === role);
      const env = Object.fromEntries(podSpec(workload).containers.find(c => c.name === role).env.map(x => [x.name, x.value]));
      if (env.NS_INPUT_TRANSPORT !== 'writer-driven' || env.NS_EVALUATOR_SLICES !== String(inventory.slices.evaluator) || env.NS_REALTIME_SLICES !== String(inventory.slices.realtime)) fail(role + ' writer target counts differ from the bound slices');
    }
  });

  run('evaluator-statefulset', fail => {
    // Decision statefulset-ordinal-scaling: a StatefulSet of slices.evaluator Pods governed by the
    // headless `evaluator` Service. Each Pod reads its ordinal from its hostname (evaluator-<i>)
    // and K from NS_EVALUATOR_SLICES; evaluator i is evaluator-<i>.evaluator.
    const hosts = workloads.filter(w => (podSpec(w).containers || []).some(c => c.name === 'evaluator'));
    if (hosts.length !== 1) return fail('the evaluator must run in exactly one workload, found ' + hosts.length);
    const w = hosts[0], k = inventory.slices.evaluator;
    if (w.kind !== 'StatefulSet' || w.spec.replicas !== k) fail(id(w) + ' must be a StatefulSet of slices.evaluator replicas');
    if (w.metadata.name !== 'evaluator' || w.spec.serviceName !== 'evaluator') fail('the evaluator StatefulSet must be governed by the evaluator Service (Pod DNS evaluator-<i>.evaluator)');
    const container = podSpec(w).containers.find(c => c.name === 'evaluator'), env = container.env || [];
    if (env.find(e => e.name === 'NS_EVALUATOR_SLICES')?.value !== String(k)) fail('NS_EVALUATOR_SLICES must equal slices.evaluator');
    if (env.some(e => ['NS_PGSTREAM_EVALUATOR_SLICE', 'NS_PGSTREAM_RECEIVER_URL', 'NS_SLICE_ORDINAL'].includes(e.name))) fail('the evaluator derives its slice and receiver from its hostname and K');
    if (JSON.stringify(container.command) !== JSON.stringify(['node', 'deploy/multitenant/entrypoint.js', 'evaluator'])) fail('the evaluator runs the entrypoint directly');
  });

  run('realtime-slices', fail => {
    // Realtime slice = pod index, K = NS_SLICE_COUNT, both from the one `slices.realtime` value.
    const w = workloads.find(x => x.kind === 'StatefulSet' && x.metadata.name === 'realtime');
    if (!w) return fail('realtime must be a StatefulSet');
    const env = Object.fromEntries((podSpec(w).containers.find(c => c.name === 'realtime').env || []).map(e => [e.name, e]));
    if (env.NS_SLICE_COUNT?.value !== String(w.spec.replicas) || w.spec.replicas !== inventory.slices.realtime) fail('NS_SLICE_COUNT and replicas must both be slices.realtime');
    if (env.NS_SLICE_ORDINAL?.valueFrom?.fieldRef?.fieldPath !== "metadata.labels['apps.kubernetes.io/pod-index']") fail('NS_SLICE_ORDINAL must come from the pod-index label');
  });

  run('role-probes', fail => {
    // Core health endpoints on the role's private listener; startup allows the 900 s warm budget.
    for (const role of ['api', 'realtime', 'evaluator', 'tenant-admin']) {
      const startupPath = role === 'tenant-admin' ? '/healthz/ready' : '/healthz/isolation';
      const hosts = workloads.flatMap(w => (podSpec(w).containers || []).filter(c => c.name === role).map(c => [w, c]));
      if (!hosts.length) fail('no container named ' + role);
      for (const [w, c] of hosts) {
        if (c.readinessProbe?.httpGet?.path !== '/healthz/ready' || c.startupProbe?.httpGet?.path !== startupPath || c.livenessProbe?.httpGet?.path !== '/healthz/live') fail(id(w) + ' container ' + role + ' must probe ' + startupPath + ' (startup), /healthz/ready (readiness) and /healthz/live (liveness)');
        const p = c.startupProbe || {};
        if ((p.periodSeconds || 10) * (p.failureThreshold || 3) < 900) fail(id(w) + ' container ' + role + ' startupProbe must allow at least 900 s (Compose start_period)');
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

  run('source-command-identity', fail => {
    for (const w of workloads) {
      // Opt-in lab metrics: exactly its two containers, at exactly the digests the inventory declares.
      const lab = inventory.labMetrics?.enabled ? { prometheus: inventory.labMetrics.images.prometheus, 'postgres-exporter': inventory.labMetrics.images.postgresExporter } : {};
      for (const c of containersOf(podSpec(w))) if (Object.hasOwn(lab, c.name) ? c.image!==lab[c.name] : !['postgres','vault','vault-agent','nginx'].includes(c.name) && c.image!==inventory.images.app) fail(c.name+' image differs from declared immutable application image');
      const a=w.metadata.annotations||{};
      if (a['nightscout.org/source-commit']!==inventory.sourceCommit || a['nightscout.org/image-deploy-commit']!==inventory.imageDeployCommit || a['nightscout.org/binding-identity']!==inventory.bindingIdentity) fail(id(w)+' provenance annotations differ from inventory');
    }
    const pg=workloads.find(w=>w.metadata.name==='postgres');
    const p=podSpec(pg).containers.find(c=>c.name==='postgres');
    if(p.command)fail('postgres must retain its image entrypoint for initdb');
    const bootstrap=containersOf(podSpec(workloads.find(w=>w.metadata.name==='provision'))).find(c=>c.name==='bootstrap');
    const env=Object.fromEntries(bootstrap.env.map(e=>[e.name,e.value]));
    if(env.NS_SOURCE_COMMIT!==inventory.sourceCommit || env.NS_DEPLOY_COMMIT!==inventory.imageDeployCommit || env.NS_INPUT_TRANSPORT !== 'writer-driven')fail('bootstrap source/producer identity is missing or wrong');
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
    // Secrets flow in, never out (decision provisioning-secrets-in): the provision Job consumes
    // seeded credentials, holds nothing for export, and no workload waits for an acknowledgement.
    const job=workloads.find(w=>w.metadata.name==='provision');
    if(job?.spec.backoffLimit!==0||!job?.spec.activeDeadlineSeconds)fail('provision requires no retry and a finite deadline');
    const spec=podSpec(job);
    if((spec.initContainers||[]).map(c=>c.name).join(',')!=='wait-stores,bootstrap'||spec.containers.map(c=>c.name).join(',')!=='vault-kubernetes-auth')
      fail('provision must run the registry bootstrap followed by Kubernetes auth');
    if((spec.volumes||[]).some(v=>v.name==='ownership-grants'))fail('C2 already owns admin grants; historical overlay is refused');
    const credentialMounts=['postgres-password','credentials-postgres','credentials-vault'];
    if (containersOf(spec).filter(c => c.volumeMounts.some(v => credentialMounts.includes(v.name))).map(c => c.name).join() !== 'bootstrap')
      fail('only the SQL bootstrap container may mount the setup credentials');
    for (const w of workloads) {
      if (w.metadata.name !== 'provision' && (podSpec(w).volumes || []).some(v => /^ns-credentials-/.test(v.secret?.secretName || ''))) fail(id(w) + ' mounts the seeded provisioning credentials');
      for (const c of containersOf(podSpec(w))) if (c.name === 'done' || /\.exported|\.ready\b|candidate-documents/.test(JSON.stringify([c.command, c.args, c.readinessProbe])))
        fail(id(w) + ' container ' + c.name + ' holds output for export');
    }
    const primer=workloads.find(w=>w.metadata.name==='primer');
    if(primer?.spec.suspend!==true || primer?.spec.backoffLimit!==0 || !primer?.spec.activeDeadlineSeconds)fail('primer must be an explicit suspended finite no-retry Job');
    const primerSpec = podSpec(primer);
    if (!primerSpec.volumes.some(v => v.name === 'client-state')) fail('lab client results need their own volume');
    if (primerSpec.volumes.some(v => v.secret && v.secret.secretName !== 'ns-config-primer'))
      fail('the lab client mounts only its unprivileged source documents');
    if (workloads.some(w => w.metadata.name === 'verification')) fail('platform verification is retired; no verification Job');
    const admin = workloads.find(w => w.metadata.name === 'admin');
    const adminSpec = podSpec(admin);
    if ((adminSpec.volumes.find(v => v.name === 'secret-admin')?.secret.items || []).some(item => item.path.startsWith('verification/'))) fail('admin mounts retired verification documents');
    if (!adminSpec.containers[0].env.some(e => e.name === 'NODE_EXTRA_CA_CERTS') ||
        !adminSpec.containers[0].volumeMounts.some(v => v.name === 'ns-ca')) fail('admin requires the scoped Vault CA mount');
    const sqlPolicy = all.find(m => m.kind === 'NetworkPolicy' && m.metadata.name === 'postgres-from-app');
    const sqlPeers = sqlPolicy.spec.ingress.flatMap(rule => rule.from.map(peer => peer.podSelector?.matchLabels?.['app.kubernetes.io/component']));
    if (sqlPeers.includes('operator')) fail('operator network policy must not admit direct PostgreSQL traffic');
    if (!sqlPeers.includes('ui'))
      fail('UI registry identity needs scoped PostgreSQL ingress');
    for(const role of ['api','realtime','evaluator','tenant-admin','admin']){
      const spec=podSpec(workloads.find(w=>w.metadata.name===role));
      const container=spec.containers.find(c=>c.name===role);
      if(!container.volumeMounts.some(v=>v.name==='secret-'+role&&v.mountPath==='/run/ns-config'&&v.readOnly))fail(role+' needs its projected Secret');
    }
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
