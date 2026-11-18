'use strict';
// Synthetic fixtures only: no registry push, pull or cluster call.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const ledger = require('./image-ledger');

const core = 'a'.repeat(40), deploy = 'b'.repeat(40), imageId = 'sha256:' + 'c'.repeat(64), repository = 'registry.example/nightscout/candidate';
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: imageId }, layers: [] }));
const digest = 'sha256:' + crypto.createHash('sha256').update(manifest).digest('hex');
const pair = { core, deploy, imageId, repository };
const pod = (imageID = repository + '@' + digest) => ({ spec: { nodeName: 'worker-a' }, status: { containerStatuses: [{ imageID, state: { terminated: { exitCode: 0 } } }] } });

test('plans one publication, records the digest once and later runs reference it', () => {
  let state = ledger.read('/nonexistent/ledger.json');
  assert.deepEqual(ledger.plan(state, pair), { action: 'publish', candidate: core + ':' + deploy, localImageId: imageId, tag: repository + ':aaaaaaaaaaaa-bbbbbbbbbbbb', dryRun: true });
  const first = ledger.record(state, pair, manifest); state = first.ledger;
  assert.equal(first.changed, true); assert.equal(first.entry.reference, repository + '@' + digest);
  assert.deepEqual(ledger.plan(state, pair), { action: 'none', candidate: core + ':' + deploy, reference: repository + '@' + digest });
  assert.equal(ledger.record(state, pair, manifest).changed, false);
  assert.equal(ledger.resolve(state, pair).reference, repository + '@' + digest);
  const other = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: imageId }, layers: [{}] }));
  assert.throws(() => ledger.record(state, pair, other), { code: 'IMAGE_LEDGER_ALREADY_PUBLISHED' });
});
test('refuses a foreign config digest, a manifest list and an unpublished candidate', () => {
  const state = ledger.read('/nonexistent/ledger.json');
  assert.throws(() => ledger.record(state, { ...pair, imageId: 'sha256:' + 'd'.repeat(64) }, manifest), { code: 'IMAGE_LEDGER_CONFIG_CHANGED' });
  assert.throws(() => ledger.record(state, pair, Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json' }))), { code: 'IMAGE_LEDGER_SINGLE_PLATFORM_MANIFEST_REQUIRED' });
  assert.throws(() => ledger.resolve(state, pair), { code: 'IMAGE_LEDGER_NOT_PUBLISHED' });
  assert.throws(() => ledger.plan(state, { ...pair, core: 'short' }), { code: 'IMAGE_LEDGER_SOURCE_PAIR_INVALID' });
});
test('records a verified cache warm once per worker', () => {
  const state = ledger.record(ledger.read('/nonexistent/ledger.json'), pair, manifest).ledger;
  assert.throws(() => ledger.warm(state, pair, pod(repository + '@sha256:' + 'e'.repeat(64))), { code: 'IMAGE_LEDGER_WARM_UNVERIFIED' });
  const warmed = ledger.warm(state, pair, pod());
  assert.deepEqual(warmed.entry.warmed, ['worker-a']); assert.equal(ledger.warm(warmed.ledger, pair, pod()).changed, false);
});
test('the command writes the ledger privately and never needs the network', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-ledger-'));
  try {
    const file = path.join(dir, 'ledger.json'), m = path.join(dir, 'manifest.json'); fs.writeFileSync(m, manifest);
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'image-ledger.js'), ...args, '--ledger', file, '--core', core, '--deploy', deploy], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(JSON.parse(run('plan', '--image-id', imageId, '--repository', repository).stdout).action, 'publish');
    assert.equal(run('resolve').status, 1);
    const recorded = run('record', '--image-id', imageId, '--repository', repository, '--manifest', m);
    assert.equal(recorded.status, 0, recorded.stderr); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(run('resolve').stdout).reference, repository + '@' + digest);
    assert.equal(JSON.parse(run('plan', '--image-id', imageId, '--repository', repository).stdout).action, 'none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
