'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');

const ROLES = ['api', 'evaluator', 'realtime'];
const BASE = '/run/ns-config/verification';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const need = (ok, code) => { if (!ok) throw fail(code); };

function read(root, name, code) {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch { throw fail(code); }
}

function fixture(namespace, runId) {
  const name = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  need(name.test(namespace || '') && name.test(runId || ''), 'K8S_CANDIDATE_FIXTURE_CHANGED');
  return { namespace, runId };
}

function sourceCheck(app, contract) {
  const embedded = read(app, 'deploy/multitenant/.image-source.json', 'K8S_CANDIDATE_SOURCE_CHANGED');
  need(['coreCommit', 'deployCommit'].every(k => embedded[k] === contract[k]), 'K8S_CANDIDATE_SOURCE_CHANGED');
  for (const key of ['diagnosticSha256', 'nativeCatalogueSha256', 'producerBinarySha256']) {
    need(/^[0-9a-f]{64}$/.test(contract[key] || ''), 'K8S_CANDIDATE_CONTRACT_REQUIRED');
  }
  need(sha256(fs.readFileSync('/usr/local/bin/pgstream')) === contract.producerBinarySha256, 'K8S_CANDIDATE_PRODUCER_CHANGED');
}

function bootstrapProof(root, app, contract, identity) {
  sourceCheck(app, contract);
  if (contract.applicationTopology === 'separate-k1') require('./network-documents.cjs').check(root);
  const boot = read(root, 'bootstrap/complete.json', 'K8S_CANDIDATE_SOURCE_CHANGED');
  need(boot.version === 2 && boot.registryMode === true && boot.evaluatorWorkers === undefined &&
    ['coreCommit', 'deployCommit'].every(k => boot[k === 'coreCommit' ? 'sourceCommit' : k] === contract[k]), 'K8S_CANDIDATE_SOURCE_CHANGED');
  read(root, 'vault-agent/complete.json', 'K8S_CANDIDATE_VAULT_PROOF_REQUIRED');
  const candidate = require(path.join(app, 'lib/tenant-lifecycle/native-selection'));
  const nativeDeploy = require(path.join(app, 'deploy/multitenant/native-lifecycle'));
  const config = require(path.join(app, 'deploy/multitenant/config'));
  const l = config.layout();
  const evaluator = read(root, 'evaluator/config.json', 'K8S_CANDIDATE_EVALUATOR_REQUIRED');
  const operation = read(root, 'evaluator/operation.json', 'K8S_CANDIDATE_NATIVE_REQUIRED');
  need(evaluator.processAssignment === undefined && evaluator.pgstream?.receiver?.url === 'http://evaluator:19913/' &&
    evaluator.pgstream.slot === l.prefix + '_pgstream' && evaluator.pgstream.streamRole === l.roles.pgstream &&
    operation.nativeSelection && operation.intakeProfile === undefined, 'K8S_CANDIDATE_NATIVE_REQUIRED');
  const native = nativeDeploy.select(l, { configs: { evaluator } }, candidate.create(operation.nativeSelection).binding.source);
  need(equal(native.binding, operation.nativeSelection) && native.binding.source.database === 'nightscout_compose_test',
    'K8S_CANDIDATE_GENERATION_CHANGED');
  need(sha256(JSON.stringify(candidate.catalogue(native))) === contract.nativeCatalogueSha256, 'K8S_CANDIDATE_CATALOGUE_CHANGED');

  const stream = read(root, 'pgstream/pgstream.yaml', 'K8S_CANDIDATE_STREAM_CHANGED');
  const endpoint = new URL(stream.source?.postgres?.url);
  const wire = require(path.join(app, 'deploy/multitenant/pgstream')).wire;
  need(endpoint.hostname === 'postgres' && endpoint.port === '5432' && endpoint.username === l.roles.pgstream &&
    endpoint.password && endpoint.pathname === '/nightscout_compose_test' && equal(stream, wire(evaluator, endpoint.href)),
    'K8S_CANDIDATE_STREAM_CHANGED');

  const admin = read(root, 'admin/config.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const primer = read(root, 'primer/config.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const selection = require(path.join(app, 'deploy/multitenant/platform-verify')).selection(primer);
  const adminEnv = read(root, 'admin/env.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const writer = new URL(adminEnv.NS_PLATFORM_VERIFY_PG);
  need(selection.adminOrigin === 'http://admin:1342' && primer.apiOrigin === 'http://api:1337' &&
    selection.namespace === l.prefix + '_platform_verification' && admin.platformVerification?.connectionEnv === 'NS_PLATFORM_VERIFY_PG' &&
    writer.hostname === 'postgres' && writer.port === '5432' && writer.username === l.roles.platform_verifier &&
    !Object.keys(primer).some(k => /credential|password|vault|connection/i.test(k)), 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const { namespace, refreshMs, maxAgeMs } = admin.platformVerification;
  const startup = contract.platformVerification === 'startup-v2';
  if (startup) need(refreshMs === undefined && maxAgeMs === undefined && selection.refreshMs === undefined && selection.maxAgeMs === undefined, 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  need(namespace === selection.namespace && refreshMs === selection.refreshMs && maxAgeMs === selection.maxAgeMs &&
    equal(admin.platformVerification.targets, ROLES.map(role => ({
      role, configFile: BASE + '/' + role + '.config.json',
      environmentFile: BASE + '/' + role + '.env.json', operationConfigFile: BASE + '/' + role + '.operation.json',
    }))), 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');

  const { loadTarget } = require(path.join(app, 'lib/server/serve/platform-verification-admin'));
  const { contract: verificationDigest } = require(path.join(app, 'lib/server/serve/platform-verification'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-kube-verification-'));
  try {
    const roles = ROLES.map(role => {
      const target = admin.platformVerification.targets.find(target => target.role === role);
      const files = {
        configFile: read(root, role + '/config.json', 'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED'),
        operationConfigFile: read(root, role + '/operation.json', 'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED'),
        environmentFile: read(root, role + '/env.json', 'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED'),
      };
      need(equal(files.operationConfigFile.nativeSelection, native.binding) &&
        files.operationConfigFile.intakeProfile === undefined && !Object.hasOwn(files.environmentFile, 'NS_PLATFORM_VERIFY_PG'),
        'K8S_CANDIDATE_GENERATION_CHANGED');
      const rewrite = (values, base) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
        value.replaceAll('/run/ns-config/config.json', base + '/' + role + '.config.json')
          .replaceAll('/run/ns-config/evaluator-metadata.json', base + '/evaluator.config.json')
          .replaceAll('/run/ns-config/operation.json', base + '/' + role + '.operation.json')]));
      need(equal(read(root, 'admin/verification/' + role + '.env.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED'), rewrite(files.environmentFile, BASE)),
        'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED');
      const mapped = { role };
      for (const [key, value] of Object.entries(files)) {
        const name = path.basename(target[key]);
        if (key !== 'environmentFile') {
          need(equal(value, read(root, 'admin/verification/' + name, 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED')),
            'K8S_CANDIDATE_VERIFICATION_DOCUMENT_CHANGED');
        }
        mapped[key] = path.join(dir, name);
        fs.writeFileSync(mapped[key], JSON.stringify(key === 'environmentFile' ? rewrite(value, dir) : value), { mode: 0o600 });
      }
      return mapped;
    }).map(target => {
      const loaded = loadTarget(target, {});
      return { role: target.role, generation: verificationDigest(loaded.config, target.role, loaded.operationConfig.intakeProfile.digest) };
    });
    const { namespace: verificationNamespace, maxAgeMs, refreshMs, roles: expectedRoles } = selection;
    const publicSelection = startup ? { namespace: verificationNamespace, roles: expectedRoles } : { namespace: verificationNamespace, maxAgeMs, refreshMs, roles: expectedRoles };
    return { version: 1, fixture: identity, diagnosticSha256: contract.diagnosticSha256,
      coreCommit: contract.coreCommit, deployCommit: contract.deployCommit, nativeSelectionSha256: native.digest, nativeSource: native.binding.source, nativeGeneration: native.binding.generation,
      selection: publicSelection, selectionSha256: sha256(JSON.stringify(selection)), roles };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function checkVerification(expected, proof, identity, contract, now = Date.now()) {
  need(expected?.version === 1 && equal(expected.fixture, identity) &&
    ['coreCommit', 'deployCommit', 'diagnosticSha256'].every(k => expected[k] === contract[k]),
    'K8S_CANDIDATE_FIXTURE_CHANGED');
  need(proof?.version === 1 && proof.status === 'verified' && proof.credentialBoundary === 'admin-private-api' &&
    equal(proof.selection, expected.selection) && proof.selectionSha256 === expected.selectionSha256,
    'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  need(Array.isArray(proof.roles) && equal(proof.roles.map(row => row.role), ROLES) &&
    equal(proof.roles.map(({ role, generation }) => ({ role, generation })), expected.roles) &&
    (contract.platformVerification === 'startup-v2' || proof.roles.every(row => Date.parse(row.expiresAt) > now)), 'K8S_CANDIDATE_VERIFICATION_GENERATION_CHANGED');
  return { ...expected, roles: proof.roles, credentialBoundary: proof.credentialBoundary };
}

async function main() {
  const app = process.cwd(), dir = path.dirname(__filename);
  const sourceContract = read(dir, 'source-contract.json', 'K8S_CANDIDATE_CONTRACT_REQUIRED');
  const topology = process.env.NS_APPLICATION_TOPOLOGY || 'cohort';
  need(['cohort', 'separate-k1'].includes(topology), 'K8S_CANDIDATE_TOPOLOGY_REQUIRED');
  const contract = {...sourceContract, applicationTopology: topology};
  const identity = fixture(process.env.NS_FIXTURE_NAMESPACE, process.env.NS_FIXTURE_RUN_ID);
  if (process.argv[2] === 'hold') {
    const root = '/state';
    if (contract.applicationTopology === 'separate-k1') require('./network-documents.cjs').project(root);
    const expected = bootstrapProof(root, app, contract, identity);
    fs.writeFileSync(path.join(root, 'primer/expected-verification.json'), JSON.stringify(expected), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(root, '.ready'), 'ready', { mode: 0o600, flag: 'wx' });
    const timer = setInterval(() => { if (fs.existsSync(path.join(root, '.exported'))) clearInterval(timer); }, 1000);
    return;
  }
  need(process.argv[2] === 'verify', 'K8S_CANDIDATE_USAGE');
  sourceCheck(app, contract);
  const root = '/run/ns-primer';
  const expected = read(root, 'expected-verification.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  need(equal(expected.fixture, identity) && ['coreCommit', 'deployCommit', 'diagnosticSha256'].every(k => expected[k] === contract[k]),
    'K8S_CANDIDATE_FIXTURE_CHANGED');
  read(root, 'provisioned.json', 'K8S_CANDIDATE_TENANT_PROOF_REQUIRED');
  const config = read(root, 'config.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const verifier = require(path.join(app, 'deploy/multitenant/platform-verify'));
  const selected = verifier.selection(config);
  need(sha256(JSON.stringify(selected)) === expected.selectionSha256, 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const proof = checkVerification(expected, await verifier.verify(config), identity, contract);
  fs.writeFileSync(path.join(root, 'verified.json'), JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
  const timer = setInterval(() => { if (fs.existsSync(path.join(root, '.exported'))) clearInterval(timer); }, 1000);
}

if (require.main === module) main().catch(error => {
  const code = error.code || '';
  console.error(/^(K8S_CANDIDATE_|PLATFORM_VERIFICATION_)[A-Z0-9_]+$/.test(code) ? code : 'K8S_CANDIDATE_DOCUMENT_REFUSED');
  process.exitCode = 1;
});
module.exports = { bootstrapProof, checkVerification, fixture };
