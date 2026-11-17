'use strict';

// Run with Mocha from the matching core checkout and a dedicated synthetic
// PostgreSQL fixture. The native lab supplies the actual role and producer
// actors; this probe passes the generated roster to the canonical DBA binding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { position } = require('../../lib/storage/clinical-stream-state');
const { setTimeout: delay } = require('node:timers/promises');
const native = require('../../tests/fixtures/pgstream-native');
const createLab = require('../../tests/fixtures/evaluator-preview-registry-lab');
const assigned = require('../../lib/pgstream/assigned-worker');
const { bucket } = require('../../lib/pool-membership/slice');
const { map: workMap } = require('../../lib/pgstream/work-state');
const { roster } = require('./evaluator-workers');

describe('native evaluator deployment process matrix', function () {
  this.timeout(90000);
  const lab = createLab();
  const originalSetup = native.setup;
  const at = Date.now() - 1000;
  let installProfile, reference;
  before(async () => {
    assert(process.env.NS_TEST_POSTGRES_ADMIN_URI, 'owned native database required');
    await lab.open();
    native.setup = input => originalSetup({ ...input, config: {
      ...input.config, processAssignment: installProfile
    } });
  });
  beforeEach(() => lab.reset());
  after(async () => {
    native.setup = originalSetup;
    await lab.close();
  });

  async function wait(check, code, milliseconds = 15000) {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      const found = await check();
      if (found) return found;
      await delay(40);
    }
    throw new Error(code);
  }
  function write(tenant, identifier, sgv) {
    return lab.persistDomains({ entries: [{
      _id: identifier, type: 'sgv', sgv, date: at, dateString: new Date(at).toISOString(), direction: 'Flat'
    }] }, tenant);
  }
  async function checkpoint(tenant, marker) {
    const { projection } = await lab.previewCheckpoint(tenant);
    const input = projection?.[0];
    const event = projection?.[1]?.events.find(row => row.domain === 'entries' && row.value.doc?.identifier === marker);
    return { position: input?.stream?.accepted_position ?? null, floor: event ? String(input.floor) : null };
  }
  async function output(tenant, marker, mgdl) {
    const row = await lab.previewCompleted(tenant);
    const point = row.projection?.[0]?.output.frame.sgvs.find(item => item._id === marker);
    if (point?.mgdl !== mgdl) return null;
    assert.match(row.output_identity, /^[a-f0-9]{64}$/);
    assert.match(row.output_digest, /^[a-f0-9]{64}$/);
    return { point, identity: row.output_identity, digest: row.output_digest, revision: row.output_revision,
      covered: workMap(row.work_completed).bootstrap };
  }
  async function profiles(n) {
    // Compose URLs are already sorted. Map them in that order to distinct
    // loopback listeners because this component run shares one local netns.
    const first = Number(process.env.NS_RT_BOOTSTRAP_PGSTREAM_RECEIVER_PORT);
    const ports = n === 1 ? [first] : [first, Number(process.env.NS_PGSTREAM_SECOND_RECEIVER_PORT)];
    assert(ports.every(port => Number.isSafeInteger(port) && port >= 1024 && port <= 65535));
    assert.equal(new Set(ports).size, n);
    const workers = roster({ workers: n });
    const receivers = ports.map(port => 'http://127.0.0.1:' + port + '/').sort();
    const configs = receivers.map((url, ordinal) => ({
      ...lab.configure(doc => { doc.pgstream.receiver.url = url; }, 'deploy-native-' + ordinal),
      processProfile: { ordinal, receivers }
    }));
    const primary = configs[receivers.indexOf('http://127.0.0.1:' + first + '/')];
    assert(primary);
    for (const config of configs) config.processSource = primary;
    installProfile = primary.processProfile;
    await lab.prepareProduct(primary);
    const directory = path.dirname(primary.file);
    const operation = JSON.parse(fs.readFileSync(path.join(directory, 'operation.json'), 'utf8'));
    const evaluator = operation.participants.find(row => row.id === 'evaluator');
    const participants = [
      ...operation.participants.filter(row => row !== evaluator),
      ...workers.map(({id}, ordinal) => ({ ...evaluator, id, address: { socket: path.join(directory, 'e' + ordinal + '.sock') } }))
    ];
    for (const [ordinal, config] of configs.entries()) {
      config.operation = { ...operation, participants, participantId: workers[ordinal].id };
      config.socket = participants.find(row => row.id === config.operation.participantId).address.socket;
    }
    const subscriptions = (await lab.admin.query('SELECT url,schema_name,table_name,event_types FROM pgstream.webhook_subscriptions')).rows;
    const expected = receivers.flatMap(url => [
      ...require('../../lib/pgstream/evaluator').routes({ ...primary.document, namespaces: primary.document.postgres.namespaces })
        .map(route => ({url: new URL('pgstream', url).href, schema_name: route.schema, table_name: route.table, event_types: ['D','I','U']})),
      {url: new URL('pgstream', url).href, schema_name: '', table_name: '', event_types: ['B','C','M']}
    ]);
    const normalized = rows => rows.map(({ url, schema_name, table_name, event_types }) =>
      JSON.stringify([url,schema_name,table_name,event_types.slice().sort()])).sort();
    assert.deepEqual(normalized(subscriptions), normalized(expected), 'CANONICAL_NATIVE_SUBSCRIPTION_SET');
    lab.tracePreview('compose-native-routes', { workers, receivers, subscriptions: subscriptions.length, slot: primary.document.pgstream.slot });
    return configs;
  }
  function writeFixture(file, value) {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    return file;
  }
  async function boot(config, duplicateSocket = false) {
    const dir = path.dirname(config.file);
    const suffix = duplicateSocket ? '-overlap' : '-' + config.processProfile.ordinal;
    const socket = duplicateSocket ? path.join(dir, 'overlap.sock') : config.socket;
    const operation = structuredClone(config.operation);
    operation.participants.find(row => row.id === operation.participantId).address.socket = socket;
    const file = writeFixture(path.join(dir, 'process-operation' + suffix + '.json'), operation);
    const before = lab.extraEnvironment;
    lab.extraEnvironment = { ...before, MULTITENANT_OPERATION_CONFIG: file, NS_SERVE_INTERNAL_SOCKET: socket, NS_EVALUATOR_INTERNAL_SOCKET: '' };
    try {
      return await lab.worker(config, { startProducer: false });
    } finally {
      lab.extraEnvironment = before;
    }
  }
  async function expectBootRefusal(config, code, duplicateSocket) {
    const refused = await boot(config, duplicateSocket);
    assert.match(JSON.stringify(refused.startup.bootError), code);
    return refused.startup.bootError.message;
  }
  async function peerReady(config) {
    try {
      const response = await fetch(new URL('pgstream/ready', config.document.pgstream.receiver.url), {signal: AbortSignal.timeout(300)});
      return response.status === 204;
    } catch {
      return false;
    }
  }
  function healthExit(config, participantId = config.operation.participantId) {
    const dir = path.dirname(config.file);
    const file = writeFixture(path.join(dir, 'health-operation.json'), { ...config.operation, participantId });
    const env = writeFixture(path.join(dir, 'health-env.json'), {
      MULTITENANT_OPERATION_CONFIG: file, NS_SERVE_INTERNAL_SOCKET: config.socket
    });
    const result = spawnSync(process.execPath, [path.join(__dirname, 'health.js'), 'evaluator'],
      { env: { PATH: process.env.PATH, NS_ENV_FILE: env }, timeout: 5000 });
    assert.ifError(result.error);
    return result.status;
  }
  async function slot() {
    const { rows } = await lab.admin.query(
      'SELECT slot_name, active, confirmed_flush_lsn::text AS confirmed, wal_status FROM pg_replication_slots WHERE slot_name=$1',
      [lab.stream().slot]);
    assert.equal(rows.length, 1, 'ONE_NATIVE_SOURCE_SLOT');
    return rows[0];
  }
  async function owner(worker, tenant) {
    const [key] = assigned.configure({ tenants: [tenant], currentGeneration: () => '1' }, {
      namespace: lab.replayNamespace, consumer: lab.consumerName
    }).key;
    const { rows } = await lab.admin.query(`SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1 AND l.mode='ExclusiveLock'
      AND l.classid::bigint=(($1::bigint >> 32) & 4294967295)
      AND l.objid::bigint=($1::bigint & 4294967295) AND a.usename=$2 AND a.datname=current_database()`,
      [key, lab.previewRole]);
    assert.equal(rows.length, 1, 'ONE_PHYSICAL_COMPLETION_OWNER_PER_SLICE');
    assert((await worker.call('health')).assignment.tenants.includes(tenant));
    return rows[0].pid;
  }
  async function exit(worker) {
    assert(worker.child.exitCode === null && worker.child.signalCode === null);
    const exited = new Promise(resolve => worker.child.once('exit', (code, signal) => resolve({code,signal})));
    // ChildProcess.kill addresses the exact still-running fixture child.
    assert(worker.child.kill('SIGKILL'));
    assert.deepEqual(await exited, {code:null,signal:'SIGKILL'});
  }
  async function inputs() {
    // The lab increments the settings version during reset. This arm comparison
    // recreates the same synthetic settings version on each fresh source.
    await lab.admin.query('UPDATE "' + lab.registryNamespaces.settings + '".tenant_settings SET version=10');
    await write(lab.A, 'seed-a', 112);
    await write(lab.B, 'seed-b', 124);
  }

  it('K1 owns the whole roster and preserves its clinical identity on producer restart', async () => {
    await inputs();
    const [config] = await profiles(1), worker = await boot(config);
    assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
    assert.deepEqual(worker.startup.health.assignment.tenants, [lab.A, lab.B]);
    const a = await owner(worker, lab.A), b = await owner(worker, lab.B);
    assert.equal(a, b, 'K1_ONE_PHYSICAL_OWNER_BACKEND');
    assert.equal(await peerReady(config), true);
    assert.equal(healthExit(config), 0);
    await lab.startStream();
    await wait(async () => (await slot()).active, 'K1_SOURCE_NOT_ACTIVE');
    const seeds = await Promise.all([[lab.A, 'seed-a', 112], [lab.B, 'seed-b', 124]]
      .map(args => wait(() => output(...args), 'K1_SEED_OUTPUT_MISSING')));
    reference = seeds.map(({point,identity}) => ({point,identity}));
    const before = await slot();
    await lab.stopStream();
    const stopped = await wait(async () => {
      const state = await slot();
      return !state.active && state;
    }, 'K1_STOPPED_PRODUCER_MUST_RELEASE_SLOT');
    await write(lab.A, 'producer-gap', 147);
    await delay(400);
    assert.equal((await checkpoint(lab.A, 'producer-gap')).floor, null);
    assert.equal(await output(lab.A, 'producer-gap', 147), null);
    assert.equal((await worker.call('health')).pgstream.healthy, true);
    await lab.startStream();
    const recovered = await wait(() => output(lab.A, 'producer-gap', 147), 'K1_PRODUCER_RESTART_MUST_REPLAY');
    const accepted = await checkpoint(lab.A, 'producer-gap');
    assert(BigInt(recovered.covered) >= BigInt(accepted.floor));
    assert.equal(recovered.identity, seeds[0].identity);
    const after = await wait(async () => {
      const state = await slot();
      return state.confirmed !== stopped.confirmed && state;
    }, 'K1_RESTART_MUST_ADVANCE_SLOT');
    lab.tracePreview('k1-producer-stop-resume', { before, stopped, after, accepted, recoveredRevision: recovered.revision, ownerBackend: a });
    await lab.stopChildren();
  });

  it('K2 refuses incomplete or foreign registration and overlaps, completes a healthy neighbor, and replays after endpoint death', async () => {
    await inputs();
    const configs = await profiles(2), a = configs[bucket(lab.A, 2)], b = configs[bucket(lab.B, 2)];
    assert.notEqual(a, b);
    const boundary = new URL('pgstream', b.document.pgstream.receiver.url).href;
    const { rows: missing } = await lab.admin.query(
      "DELETE FROM pgstream.webhook_subscriptions WHERE url=$1 AND schema_name='' AND table_name='' RETURNING *", [boundary]);
    assert.equal(missing.length, 1);
    const insert = row => lab.admin.query('INSERT INTO pgstream.webhook_subscriptions VALUES($1,$2,$3,$4)',
      [row.url,row.schema_name,row.table_name,row.event_types]);
    const missingCode = await expectBootRefusal(a, /PGSTREAM_SOURCE_REFUSED/);
    await insert(missing[0]);
    const foreign = 'http://127.0.0.1:' + process.env.NS_RT_BOOTSTRAP_PGSTREAM_SUBSCRIPTIONS_PORT + '/pgstream';
    await insert({...missing[0],url:foreign});
    const foreignCode = await expectBootRefusal(a, /PGSTREAM_SOURCE_REFUSED/);
    const removed = await lab.admin.query('DELETE FROM pgstream.webhook_subscriptions WHERE url=$1', [foreign]);
    assert.equal(removed.rowCount, 1);

    const left = await boot(a), right = await boot(b);
    assert.equal(left.startup.ready, true, JSON.stringify(left.startup));
    assert.equal(right.startup.ready, true, JSON.stringify(right.startup));
    assert.deepEqual(left.startup.health.assignment.tenants,[lab.A]);
    assert.deepEqual(right.startup.health.assignment.tenants,[lab.B]);
    const leftOwner = await owner(left, lab.A), rightOwner = await owner(right, lab.B);
    assert.notEqual(leftOwner, rightOwner, 'K2_DISJOINT_PHYSICAL_OWNER_BACKENDS');
    const duplicateSocket = await expectBootRefusal(a, /SOCKET_IPC_PATH_EXISTS/);
    const overlapReason = await expectBootRefusal(a, /OWNER_CONFLICT/, true);
    assert.equal(await owner(left, lab.A), leftOwner);
    assert(await peerReady(a)); assert(await peerReady(b));
    assert.equal(healthExit(a), 0);
    assert.equal(healthExit(a, b.operation.participantId), 1, 'HEALTH_REQUIRES_THE_EXPECTED_PRIVATE_PARTICIPANT');
    assert.equal(healthExit(a), 0);
    assert.equal(healthExit(b), 0);
    await lab.startStream();
    await wait(async () => (await slot()).active, 'K2_SOURCE_NOT_ACTIVE');
    const seeds = await Promise.all([[lab.A, 'seed-a', 112], [lab.B, 'seed-b', 124]]
      .map(args => wait(() => output(...args), 'K2_SEED_OUTPUT_MISSING')));
    assert.deepEqual(seeds.map(({point,identity}) => ({point,identity})), reference, 'K1_K2_CLINICAL_AND_IDENTITY_EQUALITY');

    await left.call('arm');
    let held = false;
    left.held().then(() => { held = true; });
    await write(lab.A, 'pending-before-death', 151);
    await wait(() => held, 'K2_LEFT_MUST_REACH_CLINICAL_HOLD');
    const pending = await wait(async () => {
      const row = await checkpoint(lab.A, 'pending-before-death');
      return row.floor && row;
    }, 'K2_RECEIPT_MUST_COMMIT_BEFORE_HOLD');
    assert.equal(await output(lab.A, 'pending-before-death', 151), null);
    await write(lab.B, 'while-neighbor-held', 162);
    const healthy = await wait(() => output(lab.B, 'while-neighbor-held', 162), 'K2_NEIGHBOR_MUST_COMPLETE_WHILE_HELD');
    assert.equal(await output(lab.A, 'pending-before-death', 151), null);
    const producer = lab.stream(), previousProducer = producer.identity();
    const healthyReceipt = await checkpoint(lab.B, 'while-neighbor-held');
    assert(healthyReceipt.position);
    await wait(async () => position((await slot()).confirmed) >= position(healthyReceipt.position),
      'HEALTHY_FANOUT_MUST_ACK_BEFORE_RECEIVER_STOP');
    await exit(left);
    assert.equal(await peerReady(a), false);
    assert.equal(await peerReady(b), true);
    const beforeFailure = await slot();
    const began = performance.now();
    await write(lab.B, 'first-with-receiver-down', 173);
    const died = await wait(() => producer.state().lastExit, 'STRICT_PRODUCER_MUST_STOP_AFTER_UNAVAILABLE_ENDPOINT');
    assert.equal(died.code, 1);
    const producerExitMs = Math.round(performance.now() - began);
    const [lastLog] = producer.state().files.slice(-1);
    assert.match(fs.readFileSync(lastLog, 'utf8'), /connection refused/i, 'ENDPOINT_OUTAGE_MUST_CAUSE_STRICT_PRODUCER_EXIT');
    const failed = await wait(async () => {
      const state = await slot();
      return !state.active && state;
    }, 'K2_FAILED_PRODUCER_MUST_RELEASE_SLOT');
    const failedCohort = await checkpoint(lab.B, 'first-with-receiver-down');
    if (failedCohort.floor) assert(position(failed.confirmed) < position(failedCohort.position), 'PARTIAL_FANOUT_MUST_NOT_ACK_SOURCE');
    await write(lab.B, 'later-with-receiver-down', 184);
    await delay(700);
    assert.equal((await checkpoint(lab.B, 'later-with-receiver-down')).floor, null, 'LATER_HEALTHY_SLICE_INTAKE_STALLS');
    assert.equal(await output(lab.B, 'later-with-receiver-down', 184), null);
    const stalled = await slot();
    assert.equal(stalled.confirmed, failed.confirmed, 'SLOT_MUST_NOT_ACK_LATER_INPUT_WHILE_DESTINATION_DOWN');
    assert.equal(stalled.active, false);
    assert.deepEqual(await checkpoint(lab.A, 'pending-before-death'), pending);
    assert.equal((await right.call('health')).pgstream.healthy, true);
    const stopped = { beforeFailure, failed, stalled, producerExitMs, observedOutageMs:Math.round(performance.now()-began), failedCohort,
      producerExit: {code:died.code, signal:died.signal}, pending };
    lab.tracePreview('k2-receiver-down', stopped);

    const replacement = await boot(a);
    assert.equal(replacement.startup.ready,true,JSON.stringify(replacement.startup));
    const newOwner = await owner(replacement, lab.A);
    assert.notEqual(newOwner, leftOwner);
    assert.equal(await owner(right, lab.B), rightOwner);
    const resumedPending = await wait(() => output(lab.A, 'pending-before-death', 151), 'ACCEPTED_WORK_MUST_RECOVER_WITHOUT_NEW_WRITE');
    assert(BigInt(resumedPending.covered) >= BigInt(pending.floor));
    assert.equal(resumedPending.identity, seeds[0].identity);
    assert.equal(await output(lab.B, 'later-with-receiver-down', 184), null);
    await lab.startStream();
    assert.notEqual(producer.identity().pid, previousProducer.pid);
    const replayed = await wait(() => output(lab.B, 'later-with-receiver-down', 184), 'SLOT_REPLAY_MUST_RECOVER_HEALTHY_SLICE');
    assert.equal(replayed.identity, seeds[1].identity);
    assert.notEqual(replayed.digest, healthy.digest);
    const accepted = await checkpoint(lab.B, 'later-with-receiver-down');
    assert(BigInt(replayed.covered) >= BigInt(accepted.floor));
    const after = await wait(async () => {
      const state = await slot();
      return state.confirmed !== stalled.confirmed && state;
    }, 'K2_RESTORED_SLOT_MUST_ADVANCE');
    const settled = await output(lab.A, 'pending-before-death', 151);
    assert.equal(settled.digest, resumedPending.digest);
    assert.equal(settled.revision, resumedPending.revision);
    assert.equal(healthExit(a), 0);
    lab.tracePreview('k2-native-restored', { missingCode, foreignCode, duplicateSocket, overlapReason, leftOwner, rightOwner, newOwner,
      after, accepted, healthyRevision: healthy.revision, replayedRevision: replayed.revision, pendingRecoveredRevision: settled.revision });
    await lab.stopChildren();
  });
});
