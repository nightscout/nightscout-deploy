#!/usr/bin/env node
'use strict';

// Candidate image ledger: publish and cache-warm once per candidate source
// pair (core commit, deploy commit), record the registry digest, and let every
// later run reference that digest. This command never pushes, pulls or calls a
// cluster. `plan` prints what the operator publishes; `record` verifies the
// registry manifest bytes read back after that publication; `warm` verifies a
// recorded cache-warm Pod status; `resolve` returns the digest reference.
//
// Manifest checks (moved from the alignment Kubernetes tooling's frozen
// registry receipt check): a single-platform schema 2 manifest whose config
// digest is the candidate's local image ID; the reference digest is the
// SHA-256 of the exact registry response bytes.
//
// Usage:
//   node image-ledger.js plan    --ledger L --core SHA --deploy SHA --image-id sha256:ID --repository REPO
//   node image-ledger.js record  --ledger L --core SHA --deploy SHA --image-id sha256:ID --repository REPO --manifest FILE
//   node image-ledger.js warm    --ledger L --core SHA --deploy SHA --pod FILE
//   node image-ledger.js resolve --ledger L --core SHA --deploy SHA
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const fail = code => Object.assign(new Error(code), { code });
const COMMIT = /^[0-9a-f]{40}$/, IMAGE_ID = /^sha256:[0-9a-f]{64}$/, REPOSITORY = /^[a-z0-9][a-z0-9._\-/:]*[a-z0-9]$/;
const MEDIA = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const key = ({ core, deploy }) => {
  if (!COMMIT.test(core || '') || !COMMIT.test(deploy || '')) throw fail('IMAGE_LEDGER_SOURCE_PAIR_INVALID');
  return core + ':' + deploy;
};
function read (file) {
  if (!fs.existsSync(file)) return { version: 1, candidates: {} };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !value.candidates || typeof value.candidates !== 'object') throw fail('IMAGE_LEDGER_INVALID');
  return value;
}
function write (file, value) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function plan (ledger, input) {
  const id = key(input), entry = ledger.candidates[id];
  if (entry) return { action: 'none', candidate: id, reference: entry.reference };
  if (!IMAGE_ID.test(input.imageId || '') || !REPOSITORY.test(input.repository || '') || input.repository.includes('@')) throw fail('IMAGE_LEDGER_INPUT_INVALID');
  return { action: 'publish', candidate: id, localImageId: input.imageId,
    tag: input.repository + ':' + input.core.slice(0, 12) + '-' + input.deploy.slice(0, 12), dryRun: true };
}
function record (ledger, input, manifestBytes) {
  const id = key(input);
  if (!IMAGE_ID.test(input.imageId || '') || !REPOSITORY.test(input.repository || '') || input.repository.includes('@')) throw fail('IMAGE_LEDGER_INPUT_INVALID');
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { throw fail('IMAGE_LEDGER_MANIFEST_INVALID'); }
  if (manifest?.schemaVersion !== 2 || !MEDIA.includes(manifest.mediaType)) throw fail('IMAGE_LEDGER_SINGLE_PLATFORM_MANIFEST_REQUIRED');
  if (manifest.config?.digest !== input.imageId) throw fail('IMAGE_LEDGER_CONFIG_CHANGED');
  const reference = input.repository + '@sha256:' + crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const previous = ledger.candidates[id];
  if (previous) {
    if (previous.reference !== reference || previous.localImageId !== input.imageId) throw fail('IMAGE_LEDGER_ALREADY_PUBLISHED');
    return { ledger, entry: previous, changed: false };
  }
  const entry = { core: input.core, deploy: input.deploy, localImageId: input.imageId, reference, warmed: [] };
  return { ledger: { ...ledger, candidates: { ...ledger.candidates, [id]: entry } }, entry, changed: true };
}
function warm (ledger, input, pod) {
  const id = key(input), entry = ledger.candidates[id];
  if (!entry) throw fail('IMAGE_LEDGER_NOT_PUBLISHED');
  const digest = entry.reference.split('@')[1], node = pod?.spec?.nodeName;
  const statuses = [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])];
  const pulled = statuses.some(row => typeof row.imageID === 'string' && row.imageID.endsWith('@' + digest) &&
    (row.state?.running || row.state?.terminated?.exitCode === 0));
  if (typeof node !== 'string' || !node || !pulled) throw fail('IMAGE_LEDGER_WARM_UNVERIFIED');
  if (entry.warmed.includes(node)) return { ledger, entry, changed: false };
  const next = { ...entry, warmed: [...entry.warmed, node].sort() };
  return { ledger: { ...ledger, candidates: { ...ledger.candidates, [id]: next } }, entry: next, changed: true };
}
function resolve (ledger, input) {
  const entry = ledger.candidates[key(input)];
  if (!entry) throw fail('IMAGE_LEDGER_NOT_PUBLISHED');
  return entry;
}
function main (argv) {
  const [command, ...rest] = argv, args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--(ledger|core|deploy|image-id|repository|manifest|pod)$/.test(rest[i]) || rest[i + 1] === undefined) throw fail('IMAGE_LEDGER_USAGE');
    args[rest[i].slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = rest[i + 1];
  }
  if (!args.ledger) throw fail('IMAGE_LEDGER_USAGE');
  const ledger = read(args.ledger);
  let output;
  if (command === 'plan') output = plan(ledger, args);
  else if (command === 'resolve') output = resolve(ledger, args);
  else if (command === 'record' || command === 'warm') {
    if (!args[command === 'record' ? 'manifest' : 'pod']) throw fail('IMAGE_LEDGER_USAGE');
    const result = command === 'record' ? record(ledger, args, fs.readFileSync(args.manifest)) : warm(ledger, args, JSON.parse(fs.readFileSync(args.pod, 'utf8')));
    if (result.changed) write(args.ledger, result.ledger);
    output = { ...result.entry, changed: result.changed };
  } else throw fail('IMAGE_LEDGER_USAGE');
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.code || 'IMAGE_LEDGER_FAILED'); process.exitCode = 1; }
}
module.exports = { plan, record, warm, resolve, read };
