'use strict';

// Bootstrap, verification and private client-result export.
//
// `hold` (provision Job): after the source bootstrap and Vault Kubernetes auth
// init containers exit 0, project the separate-K1 network addresses, publish a
// public expected-verification record, signal ready and keep the private state
// available until the publisher acknowledges export.
//
// `verify` (verification Job): ask the private admin to run the source platform
// verification and publish its receipt. Serving roles start only after this
// passes; each serving role still checks its own proof and fails closed.
//
// Image and source identity come from the immutable image digest and Kubernetes
// Job ordering. This helper does not re-derive or compare source documents,
// catalogues, commits or binaries (decision architecture-justified-removal).
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

function read(root, name, code) {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch { throw fail(code); }
}

function optional(root, name) {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch { return undefined; }
}

function fixture(namespace, runId) {
  return { namespace, runId };
}

// Public provenance record copied from the binding's source contract and the
// bootstrap's own native selection. Informational: nothing here refuses.
function expectedRecord(root, contract, identity) {
  const record = { version: 1, fixture: identity };
  for (const key of ['coreCommit', 'deployCommit', 'diagnosticSha256']) {
    if (contract[key] !== undefined) record[key] = contract[key];
  }
  const native = optional(root, 'evaluator/operation.json')?.nativeSelection;
  if (native && typeof native === 'object') {
    record.nativeSelectionSha256 = sha256(JSON.stringify(native));
    if (native.source !== undefined) record.nativeSource = native.source;
    if (native.generation !== undefined) record.nativeGeneration = native.generation;
  }
  return record;
}

function hold(root, contract, identity, topology) {
  if (topology === 'separate-k1') require('./network-documents.cjs').project(root);
  const expected = expectedRecord(root, contract, identity);
  fs.mkdirSync(path.join(root, 'primer'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'primer/expected-verification.json'), JSON.stringify(expected), { mode: 0o600, flag: 'wx' });
  return expected;
}

// The source verifier already refuses anything but a complete `verified`
// receipt for the selected roles; keep that refusal as the only gate here.
function verificationRecord(expected, receipt) {
  if (receipt?.status !== 'verified') throw fail('K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  return { ...(expected || {}), version: 1, status: receipt.status, selection: receipt.selection,
    selectionSha256: receipt.selectionSha256, roles: receipt.roles, credentialBoundary: receipt.credentialBoundary };
}

async function verify(app, root, identity, contract) {
  const expected = optional(root, 'expected-verification.json') || expectedRecord(root, contract, identity);
  const config = read(root, 'config.json', 'K8S_CANDIDATE_ADMIN_PROOF_REQUIRED');
  const receipt = await require(path.join(app, 'deploy/multitenant/platform-verify')).verify(config);
  const record = verificationRecord({ ...expected, fixture: identity }, receipt);
  fs.writeFileSync(path.join(root, 'verified.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  return record;
}

function waitForExport(root) {
  const timer = setInterval(() => { if (fs.existsSync(path.join(root, '.exported'))) clearInterval(timer); }, 1000);
}

async function main() {
  const app = process.cwd(), dir = path.dirname(__filename);
  const contract = optional(dir, 'source-contract.json') || {};
  const identity = fixture(process.env.NS_FIXTURE_NAMESPACE, process.env.NS_FIXTURE_RUN_ID);
  if (process.argv[2] === 'hold') {
    const root = '/state';
    hold(root, contract, identity, process.env.NS_APPLICATION_TOPOLOGY || 'cohort');
    fs.writeFileSync(path.join(root, '.ready'), 'ready', { mode: 0o600, flag: 'wx' });
    waitForExport(root);
    return;
  }
  if (process.argv[2] === 'export-client') {
    waitForExport('/run/ns-client');
    return;
  }
  if (process.argv[2] !== 'verify') throw fail('K8S_CANDIDATE_USAGE');
  const root = '/run/ns-primer';
  const proof = await verify(app, root, identity, contract);
  console.log(JSON.stringify(proof));
}

// Codes only: messages can carry private document detail.
function refusalCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(code) ? code : 'K8S_CANDIDATE_DOCUMENT_REFUSED';
}

if (require.main === module) main().catch(error => {
  console.error(refusalCode(error));
  process.exitCode = 1;
});
module.exports = { expectedRecord, fixture, hold, refusalCode, verificationRecord, verify };
