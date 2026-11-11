#!/usr/bin/env node
'use strict';

// Invariants of the rendered Kubernetes binding. Offline: renders with `tk eval`, reads no
// cluster. Every check has a break-it control in check/controls.js.
//
//   node check/invariants.js [--root <tanka root>] [--env environments/preview] [--compose <bindings/compose dir>]
//
// Prints one line per check, `ok   <check>` or `FAIL <check>: <reason>`, and exits 1 on any failure.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');

function args (argv) {
  const out = { root: path.resolve(__dirname, '..'), env: 'environments/preview', compose: null };
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
  return JSON.parse(execFileSync('tk', ['eval', env, ...extra], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
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
  return (m.spec.template.metadata || {}).labels || {};
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

  run('internal-listener-not-on-service', fail => {
    const withIpc = workloads.filter(w => (podSpec(w).volumes || []).some(v => v.name === 'ns-ipc'));
    if (withIpc.length !== 1) fail('the serve.internal socket volume ns-ipc must be in exactly one Pod template, found ' + withIpc.length + ' (' + withIpc.map(id).join(', ') + ')');
    for (const w of withIpc) {
      const vol = podSpec(w).volumes.find(v => v.name === 'ns-ipc');
      if (!vol.emptyDir || Object.keys(vol).length !== 2) fail(id(w) + ' volume ns-ipc must be a pod-private emptyDir, found ' + Object.keys(vol).filter(k => k !== 'name').join(','));
    }
    for (const w of workloads) {
      for (const c of containersOf(podSpec(w))) {
        for (const e of c.env || []) {
          if (/^NS_SERVE_INTERNAL_(HOST|PORT)$/.test(e.name) || /^NS_[A-Z_]+_INTERNAL_URL$/.test(e.name)) fail(id(w) + ' container ' + c.name + ' sets ' + e.name + ': serve.internal stays a unix socket in this binding');
        }
      }
    }
    for (const svc of services) {
      for (const sp of svc.spec.ports || []) {
        const hit = resolve(svc, sp);
        if (!hit.length) fail('Service/' + svc.metadata.name + ' port ' + (sp.name || sp.port) + ' targets no declared container port (an undeclared listener, such as a network serve.internal)');
        for (const t of hit) if (/^int-/.test(t.port.name || '') && !(t.port.name === 'int-admin' && svc.metadata.name === 'admin')) fail('Service/' + svc.metadata.name + ' publishes internal port ' + t.port.name + ' of ' + id(t.workload) + ' container ' + t.container);
      }
    }
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
    const SECRET_NAME = /^(?!.*_(TTL|FILE|PATH|ENV)$).*(PASSWORD|TOKEN|SECRET|CREDENTIAL|PRIVATE)|_PG$|^NS_VAULT_[0-9]+$/;
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

  run('evaluator-statefulset', fail => {
    const hosts = workloads.filter(w => containersOf(podSpec(w)).some(c => c.name === 'evaluator'));
    if (hosts.length !== 1) return fail('the evaluator must run in exactly one workload, found ' + hosts.length);
    const w = hosts[0];
    if (w.kind !== 'StatefulSet') return fail('the evaluator runs in ' + id(w) + '; it must be a StatefulSet (the ordinal is the worker index)');
    if (w.spec.replicas !== 1) fail(id(w) + ' replicas is ' + w.spec.replicas + '; the preview runs one member');
    const env = Object.fromEntries((podSpec(w).containers.find(c => c.name === 'evaluator').env || []).map(e => [e.name, e]));
    const ordinal = env[inventory.evaluatorPool.ordinalEnv], members = env[inventory.evaluatorPool.membersEnv];
    if (!ordinal || ordinal.valueFrom?.fieldRef?.fieldPath !== "metadata.labels['apps.kubernetes.io/pod-index']") fail('evaluator env ' + inventory.evaluatorPool.ordinalEnv + ' must come from the StatefulSet pod-index label');
    if (!members || members.value !== String(w.spec.replicas)) fail('evaluator env ' + inventory.evaluatorPool.membersEnv + ' must equal the StatefulSet replicas (' + w.spec.replicas + '), found ' + (members ? members.value : 'none'));
  });

  run('no-overlap-update', fail => {
    for (const w of workloads) {
      if (w.kind === 'StatefulSet') {
        if ((w.spec.podManagementPolicy || 'OrderedReady') !== 'OrderedReady') fail(id(w) + ' podManagementPolicy must be OrderedReady');
        const u = w.spec.updateStrategy || {};
        if ((u.type || 'RollingUpdate') !== 'RollingUpdate' || (u.rollingUpdate && u.rollingUpdate.maxUnavailable !== undefined)) fail(id(w) + ' updateStrategy must be the default one-at-a-time RollingUpdate');
        if (w.spec.replicas !== 1) fail(id(w) + ' replicas must be 1 for a delete-before-create update');
      }
      if (w.kind === 'Deployment' && (w.spec.strategy || {}).type !== 'Recreate') fail(id(w) + ' strategy must be Recreate (a RollingUpdate overlaps old and new Pods)');
    }
  });

  run('service-links-off', fail => {
    for (const w of workloads) if (podSpec(w).enableServiceLinks !== false) fail(id(w) + ' must set enableServiceLinks: false (Service links inject <SERVICE>_PORT=tcp://... and collide with API_PORT/REALTIME_PORT/ADMIN_PORT)');
  });

  run('postgres-identities-match-compose', fail => {
    const configFile = path.join(composeDir, 'multitenant', 'config.js');
    const text = fs.readFileSync(configFile, 'utf8');
    const block = text.slice(text.indexOf('const environments={'), text.indexOf('const admission='));
    if (!block) return fail('cannot find the environments block in ' + configFile);
    const compose = {};
    for (const role of ['api', 'realtime', 'evaluator', 'tenant-admin']) {
      const key = role === 'tenant-admin' ? "'tenant-admin':{" : (role === 'api' ? '{api:{' : '\n    ' + role + ':{');
      const start = block.indexOf(key);
      if (start < 0) return fail('role ' + role + ' not found in ' + configFile);
      const line = block.slice(start, block.indexOf('\n', start + 1) < 0 ? undefined : block.indexOf('\n', start + 1));
      compose[role] = [...line.matchAll(/urls\.([a-z_]+)/g)].map(m => m[1]);
      if (/NS_LIFETIME_PG:urls\['lifetime_'\+role/.test(block)) compose[role].push('lifetime_' + role.replace('-', '_'));
    }
    const overlay = path.join(composeDir, 'ownership-admin', 'ownership-grants.js');
    if (!fs.existsSync(overlay)) fail('the ownership overlay ' + path.relative(process.cwd(), overlay) + ' is missing: the admin identity has no Compose counterpart in this tree');
    else {
      const m = /const ROLE = '([a-z_]+)'/.exec(fs.readFileSync(overlay, 'utf8'));
      compose.admin = m ? [m[1]] : [];
    }
    for (const [role, names] of Object.entries(compose)) {
      const want = [...new Set(names)].sort(), have = [...(inventory.postgresIdentities[role] || [])].sort();
      if (JSON.stringify(want) !== JSON.stringify(have)) fail(role + ': binding names ' + (have.join(',') || 'none') + ', Compose names ' + (want.join(',') || 'none'));
    }
    for (const role of Object.keys(inventory.postgresIdentities)) if (!compose[role] && role !== 'admin') fail(role + ' has no Compose counterpart');
    const source = fs.readFileSync(path.join(composeDir, 'SOURCE.md'), 'utf8');
    const commit = (/upstream commit \| `([0-9a-f]{40})`/.exec(source) || [])[1];
    if (commit !== envMain.sourceCommit) fail('the binding renders core ' + envMain.sourceCommit + ' but the Compose tree records ' + commit);
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
