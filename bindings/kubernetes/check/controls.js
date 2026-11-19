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
  { check: 'admin-vault-trust', file: LIB, why: 'admin loses Vault CA startup setting',
    from: "env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' }],", to: 'env: [],',
    expect: 'source admin must load the exact Vault CA before Node startup' },
  { check: 'admin-vault-trust', file: LIB, why: 'admin loses read-only Vault CA mount',
    from: "volumeMounts: [configMount('admin'), caMount, tmpMount]", to: "volumeMounts: [configMount('admin'), tmpMount]",
    expect: 'source admin requires the read-only namespace Vault CA mount' },
  { check: 'admin-vault-trust', file: LIB, why: 'admin loses namespace Vault CA volume',
    from: "volumes: configVolumes('admin') + [ca, tmp]", to: "volumes: configVolumes('admin') + [tmp]",
    expect: 'source admin requires the read-only namespace Vault CA mount' },
  { check: 'admin-vault-provisioning-network', file: LIB, why: 'source admin loses Vault access',
    from: "[sel('cohort'), sel('admin'), sel('provision'), sel('vault')]", to: "[sel('cohort'), sel('provision'), sel('vault')]",
    expect: 'source admin provisioning requires Vault TCP8200 ingress' },
  { check:'independent-pgstream',file:LIB,why:'multiple consumers of one slot',from:"metadata: meta('pgstream', 'pgstream'),\n        spec: {\n          replicas: 1",to:"metadata: meta('pgstream', 'pgstream'),\n        spec: {\n          replicas: 2",expect:'pgstream must be a one-replica Recreate Deployment' },
  { check:'independent-pgstream',file:LIB,why:'stream Service routes to any evaluator replica',from:"selector: labels('cohort') + { 'statefulset.kubernetes.io/pod-name': 'cohort-0' }",to:"selector: labels('cohort')",expect:'intake Service must select only the admitted cohort-0 owner' },
  { check:'independent-pgstream',file:LIB,why:'pod-wide readiness blocks the stream startup',from:"publishNotReadyAddresses: true, selector: labels('cohort')",to:"publishNotReadyAddresses: false, selector: labels('cohort')",expect:'intake routing must bypass pod-wide clinical readiness' },
  { check:'independent-pgstream',file:LIB,why:'separate wire Secret omitted',from:"secretName: 'ns-config-pgstream'",to:"secretName: 'ns-config-evaluator'",expect:'pgstream requires its dedicated wire Secret' },
  { check:'independent-pgstream',file:LIB,why:'required output plugin setting omitted',from:", '-c', 'output_plugin_libraries=wal2json'",to:'',expect:'PostgreSQL is missing maintained streaming setting output_plugin_libraries=wal2json' },

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
  { check: 'images-pinned', file: LIB, why: 'vault image by floating tag',
    from: "vault: 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',", to: "vault: 'hashicorp/vault:latest',",
    expect: 'image hashicorp/vault:latest is not pinned by digest or exact tag' },
  { check: 'evaluator-statefulset', file: LIB, why: 'ordinal rendered with the partition off',
    from: "                ] else []),\n                // The owner plane", to: "                ] else [{ name: c.evaluatorPool.ordinalEnv, valueFrom: { fieldRef: { fieldPath: \"metadata.labels['apps.kubernetes.io/pod-index']\" } } }]),\n                // The owner plane",
    expect: 'partition is off but the evaluator sets MULTITENANT_POOL_EVALUATOR_ORDINAL' },
  { check: 'render', file: 'environments/synthetic/main.jsonnet', why: 'stale evaluator pool selected for C3',
    from: "ns.new(import 'inputs.json')", to: "ns.new((import 'inputs.json') + { evaluatorPool: { partition: 'on' } })",
    expect: 'C3 requires the native K=1 evaluator without pool placement' },
  { check: 'evaluator-statefulset', file: LIB, why: 'readiness made to depend on something other than the role health check',
    from: "readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', role] }", to: "readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', role, 'pool'] }",
    expect: 'evaluator readiness must be the role health check only' },
  { check: 'startup-budget', file: LIB, why: 'startup budget cut to 5 s x 30 = 150 s',
    from: "periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 180 },", to: "periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },",
    expect: 'container api startupProbe allows 150 s; it must allow at least 900 s (Compose start_period)' },
  { check: 'startup-budget', file: LIB, why: 'startup probe dropped from the evaluator',
    from: "std.member(['api', 'realtime', 'evaluator'], role)", to: "std.member(['api', 'realtime'], role)",
    expect: 'container evaluator has no startupProbe' },
  { check: 'no-overlap-update', file: LIB, why: 'cohort Pods managed in parallel',
    from: "podManagementPolicy: 'OrderedReady',", to: "podManagementPolicy: 'Parallel',",
    expect: 'StatefulSet/cohort podManagementPolicy must be OrderedReady' },
  { check: 'cohort-single-replica', file: LIB, why: 'cohort StatefulSet set to two replicas (bypassing the renderer assert)',
    from: "replicas: c.cohort.replicas,", to: "replicas: 2,",
    expect: 'StatefulSet/cohort replicas is 2; the one-Pod cohort is a monolith and scales vertically only; for horizontal scale or HA use per-role placement (decision cohort-pod-not-scaled)' },
  { check: 'private-directories', file: LIB, why: 'socket volume mounted at its root (the first smoke failure)',
    from: "{ name: 'ns-ipc', mountPath: '/run/ns-ipc', subPath: 'd' },", to: "{ name: 'ns-ipc', mountPath: '/run/ns-ipc' },",
    expect: 'container api mounts ns-ipc at its root; mount the 0700 subdirectory (subPath d)' },
  { check: 'service-links-off', file: LIB, why: 'Service links back on for the cohort',
    from: "with the roles' own <ROLE>_PORT settings.\n              enableServiceLinks: false,", to: "with the roles' own <ROLE>_PORT settings.\n              enableServiceLinks: true,",
    expect: 'StatefulSet/cohort must set enableServiceLinks: false' },
  { check: 'postgres-identities-match-compose', file: LIB, why: 'admin inventory drops the verification writer',
    from: 'postgresIdentities: source.postgresIdentities,', to: 'postgresIdentities: source.postgresIdentities + { admin: [] },',
    expect: 'platform_verifier' },
  { check: 'source-command-identity', file: LIB, why: 'producer image changed independently of application',
    from: "name: 'pgstream', image: c.images.app", to: "name: 'pgstream', image: c.images.postgres",
    expect: 'pgstream image differs from declared immutable application image' },
  { check: 'independent-pgstream', file: LIB, why: 'producer configuration path changed',
    from: "'/run/ns-stream/pgstream.yaml', '--log-level', 'info'", to: "'/run/ns-stream/absent.yaml', '--log-level', 'info'",
    expect: 'pgstream must run the maintained binary directly' },
  { check: 'container-budgets', file: LIB, why: 'api budget omitted',
    from: 'resources: resources(x.name)', to: "resources: if x.name == 'api' then {} else resources(x.name)",
    expect: 'container api missing positive requests.cpu' },
  { check: 'container-budgets', file: LIB, why: 'native Vault sidecar budget omitted',
    from: 'resources: resources(x.name)', to: "resources: if x.name == 'vault-agent' then {} else resources(x.name)",
    expect: 'container vault-agent missing positive requests.cpu' },
  { check: 'existing-capacity-profile', file: LIB, why: 'public edge adds a provider resource',
    from: 'type: c.edge.serviceType', to: "type: 'LoadBalancer'",
    expect: 'Service/edge must be ClusterIP for existing-capacity' },
  { check: 'provision-boundary', file: LIB, why: 'provision done container no longer holds for export',
    from: "step('done', ['node', '/run/ns-overlay/candidate-documents.cjs', 'hold']", to: "step('done', ['node', '/run/ns-overlay/candidate-documents.cjs', 'verify']",
    expect: 'provision must hold private output until explicit export' },

  { check: 'provision-boundary', file: LIB, why: 'client export misses private provisioning result',
    from: "'test', '-s', '/run/ns-client/provisioned.json'", to: "'test', '-s', '/run/ns-client/unknown.json'",
    expect: 'lab client must retain its private provisioning results until export' },
  { check: 'provision-boundary', file: LIB, why: 'one nested admin document missing from the volume projection',
    from: "['config', 'env', 'operation']", to: "['config', 'env']",
    expect: 'admin lacks a private verification target document' },
  { check: 'provision-boundary', file: LIB, why: 'primer can connect directly to PostgreSQL',
    from: "sel('admin'), sel('ui'), sel('provision')], [{ port: 5432", to: "sel('admin'), sel('ui'), sel('provision'), sel('operator')], [{ port: 5432",
    expect: 'operator network policy must not admit direct PostgreSQL traffic' },
  { check: 'provision-boundary', file: LIB, why: 'UI registry traffic is refused by PostgreSQL ingress',
    from: "sel('admin'), sel('ui'), sel('provision')], [{ port: 5432", to: "sel('admin'), sel('provision')], [{ port: 5432",
    expect: 'UI registry identity needs scoped PostgreSQL ingress' },

];

function main () {
  const argv = process.argv.slice(2);
  const compose = path.resolve(argv[0] === '--compose' ? argv[1] : path.join(__dirname, '..', '..', 'compose'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-k8s-controls-'));
  const root = path.join(scratch, 'bindings', 'kubernetes'), composeCopy = path.join(scratch, 'bindings', 'compose');
  fs.cpSync(path.resolve(__dirname, '..'), root, { recursive: true });
  // The complete package has no imports or runtime dependency on sibling Compose files.
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
    const hit = control.check === 'render' ? broken.out.includes(control.expect) : !!line;
    const pass = broken.code === 1 && hit && restored.code === 0;
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
