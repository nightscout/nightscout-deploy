#!/usr/bin/env node
'use strict';

// Break-it controls for check/invariants.js. Each control mutates the Jsonnet in a scratch copy
// of the binding, renders, and requires the named check to go red with the expected message;
// the file is then restored and the clean copy must be green again. The working tree is never
// edited.
//
//   node check/controls.js [--compose <bindings/compose dir>]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const LIB = 'lib/ns/nightscout.libsonnet';
const CONTROLS = [
  { check: 'internal-listener-not-on-service', file: LIB, why: 'socket volume moved to a node path shared across Pods',
    from: "{ name: 'ns-ipc', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },", to: "{ name: 'ns-ipc', hostPath: { path: '/run/ns-ipc' } },",
    expect: 'volume ns-ipc must be a pod-private emptyDir, found hostPath' },
  { check: 'internal-listener-not-on-service', file: LIB, why: 'a Service publishes the owner plane',
    from: "ports: [{ name: 'http', port: 1339, targetPort: 'http-realtime' }]", to: "ports: [{ name: 'http', port: 1339, targetPort: 'int-owner' }]",
    expect: 'Service/realtime publishes internal port int-owner' },
  { check: 'admin-not-public', file: LIB, why: 'admin Service made a LoadBalancer',
    from: "spec: { type: 'ClusterIP', selector: labels('admin')", to: "spec: { type: 'LoadBalancer', selector: labels('admin')",
    expect: 'Service/admin exposes the admin port as LoadBalancer' },
  { check: 'secrets-by-reference', file: LIB, why: 'a connection string written into the api container env',
    from: "roleContainer('api', [{ name: 'http-api', containerPort: 1337 }]),",
    to: "roleContainer('api', [{ name: 'http-api', containerPort: 1337 }], [{ name: 'NS_API_PG', value: 'postgres://nsdemo_api:synthetic@postgres:5432/nightscout_compose_test' }]),",
    expect: 'env NS_API_PG is a literal; it must come from a Secret reference' },
  { check: 'images-pinned', file: LIB, why: 'postgres image by floating tag',
    from: "postgres: 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',", to: "postgres: 'postgres:16',",
    expect: 'image postgres:16 is not pinned by digest or exact tag' },
  { check: 'evaluator-statefulset', file: LIB, why: 'ordinal rendered with the partition off',
    from: "                ] else []),\n                // The owner plane", to: "                ] else [{ name: c.evaluatorPool.ordinalEnv, valueFrom: { fieldRef: { fieldPath: \"metadata.labels['apps.kubernetes.io/pod-index']\" } } }]),\n                // The owner plane",
    expect: 'partition is off but the evaluator sets MULTITENANT_POOL_EVALUATOR_ORDINAL' },
  { check: 'evaluator-statefulset', file: 'environments/preview/main.jsonnet', why: 'partition on, ordinal from the pod name instead of the pod-index label',
    from: "  prefix: 'nsdemo',", to: "  prefix: 'nsdemo',\n  evaluatorPool: { partition: 'on' },",
    alsoFile: LIB, alsoFrom: "fieldPath: \"metadata.labels['apps.kubernetes.io/pod-index']\" } } },\n                  // The member count", alsoTo: "fieldPath: 'metadata.name' } } },\n                  // The member count",
    expect: 'evaluator env MULTITENANT_POOL_EVALUATOR_ORDINAL must come from the StatefulSet pod-index label' },
  { check: 'evaluator-statefulset', file: LIB, why: 'readiness made to depend on something other than the role health check',
    from: "readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', role] }", to: "readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', role, 'pool'] }",
    expect: 'evaluator readiness must be the role health check only' },
  { check: 'no-overlap-update', file: LIB, why: 'cohort Pods managed in parallel',
    from: "podManagementPolicy: 'OrderedReady',", to: "podManagementPolicy: 'Parallel',",
    expect: 'StatefulSet/cohort podManagementPolicy must be OrderedReady' },
  { check: 'private-directories', file: LIB, why: 'socket volume mounted at its root (the first smoke failure)',
    from: "{ name: 'ns-ipc', mountPath: '/run/ns-ipc', subPath: 'd' },", to: "{ name: 'ns-ipc', mountPath: '/run/ns-ipc' },",
    expect: 'container api mounts ns-ipc at its root; mount the 0700 subdirectory (subPath d)' },
  { check: 'service-links-off', file: LIB, why: 'Service links back on for the cohort',
    from: "with the roles' own <ROLE>_PORT settings.\n              enableServiceLinks: false,", to: "with the roles' own <ROLE>_PORT settings.\n              enableServiceLinks: true,",
    expect: 'StatefulSet/cohort must set enableServiceLinks: false' },
  { check: 'postgres-identities-match-compose', file: LIB, why: 'api inventory drops the root writer identity',
    from: "api: ['alarm', 'api', 'lifetime_api', 'readiness', 'root_writer'],", to: "api: ['alarm', 'api', 'lifetime_api', 'readiness'],",
    expect: 'api: binding names alarm,api,lifetime_api,readiness, Compose names alarm,api,lifetime_api,readiness,root_writer' },
];

function main () {
  const argv = process.argv.slice(2);
  const compose = path.resolve(argv[0] === '--compose' ? argv[1] : path.join(__dirname, '..', '..', 'compose'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-controls-'));
  const root = path.join(scratch, 'bindings', 'kubernetes'), composeCopy = path.join(scratch, 'bindings', 'compose');
  fs.cpSync(path.resolve(__dirname, '..'), root, { recursive: true });
  fs.cpSync(compose, composeCopy, { recursive: true });
  const invariants = () => {
    try { return { code: 0, out: execFileSync('node', [path.join(root, 'check', 'invariants.js'), '--root', root, '--compose', composeCopy], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { code: error.status, out: String(error.stdout) + String(error.stderr) }; }
  };
  let bad = 0;
  const baseline = invariants();
  process.stdout.write('baseline: exit ' + baseline.code + (baseline.code ? '\n' + baseline.out : '') + '\n');
  if (baseline.code) bad++;
  for (const control of CONTROLS) {
    const file = path.join(root, control.file), original = fs.readFileSync(file, 'utf8');
    const count = original.split(control.from).length - 1;
    if (count !== 1) { bad++; process.stdout.write('MISMATCH ' + control.check + ': mutation text found ' + count + ' times\n'); continue; }
    const also = control.alsoFile ? path.join(root, control.alsoFile) : null, alsoOriginal = also ? fs.readFileSync(also, 'utf8') : null;
    if (also && alsoOriginal.split(control.alsoFrom).length !== 2) { bad++; process.stdout.write('MISMATCH ' + control.check + ': second mutation text not found once\n'); continue; }
    fs.writeFileSync(file, original.replace(control.from, control.to));
    if (also) fs.writeFileSync(also, alsoOriginal.replace(control.alsoFrom, control.alsoTo));
    const broken = invariants();
    fs.writeFileSync(file, original);
    if (also) fs.writeFileSync(also, alsoOriginal);
    const restored = invariants();
    const line = broken.out.split('\n').find(l => l.startsWith('FAIL ' + control.check + ': ') && l.includes(control.expect));
    const others = broken.out.split('\n').filter(l => l.startsWith('FAIL ') && !l.startsWith('FAIL ' + control.check + ': '));
    const pass = broken.code === 1 && !!line && restored.code === 0;
    if (!pass) bad++;
    process.stdout.write((pass ? 'red-as-expected ' : 'CONTROL-FAILED ') + control.check + ' (' + control.why + ')\n' +
      '  broken: exit ' + broken.code + ': ' + (line || broken.out.trim().split('\n').filter(l => l.startsWith('FAIL')).join(' | ') || 'no FAIL line') + '\n' +
      (others.length ? '  also red: ' + others.join(' | ') + '\n' : '') +
      '  restored: exit ' + restored.code + '\n');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  process.stdout.write(CONTROLS.length + ' controls, ' + bad + ' not as expected\n');
  process.exitCode = bad ? 1 : 0;
}
main();
