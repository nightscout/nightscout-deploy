#!/usr/bin/env node
'use strict';
// Finite native component proof. Uses a new private Vault/Agent namespace, never
// a prepared deployment or production credential. No API/client/HA admission.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const https = require('node:https'), net = require('node:net'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const IMAGE = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const args = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i += 2) { if (!['--core','--out','--phase'].includes(args[i]) || !args[i + 1]) throw Error('OPERATING_COMPONENT_ARGUMENTS'); opts[args[i].slice(2)] = args[i + 1]; }
function command (name, argv, input) {
  const r = spawnSync(name, argv, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
  if (r.error || r.status) { if (fs.existsSync(path.join(out, 'private'))) fs.writeFileSync(path.join(out, 'private/failed-command.json'), JSON.stringify({name, argv, status:r.status, error:r.error?.code, stderr:r.stderr}), {mode:0o600}); throw Object.assign(Error('OPERATING_COMPONENT_COMMAND'), { command:name, status:r.status, causeCode:r.error?.code }); }
  return r.stdout.trim();
}
const deploy = process.env.NS_OPERATING_DEPLOY || path.resolve(__dirname, '../../../..'), core = path.resolve(opts.core || ''), out = path.resolve(opts.out || '');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(Error(code), { code });
function need (value, code) { if (!value) throw fail(code); }
function request (origin, ca, resource, body, token, method = 'POST') {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/' + resource, origin), req = https.request(url, {
      ca, rejectUnauthorized: true, method, agent: false, timeout: 3000,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Vault-Token': token } : {}) }
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', block => { size += block.length; if (size > 1048576) req.destroy(fail('OPERATING_RESPONSE_BOUND')); else chunks.push(block); });
      response.on('end', () => { let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: response.statusCode, value, authorized: response.socket?.authorized !== false }); });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail('OPERATING_REQUEST_TIMEOUT'))); req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function until (body, ms, code) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await body(); if (result) return result; await pause(100); }
  throw fail(code);
}
async function prove () {
  const c = JSON.parse(fs.readFileSync(path.join(out, 'private/context.json'))), ca = fs.readFileSync(path.join(out, 'private/tls/ca.crt'));
  const origin = 'https://localhost:' + c.port, vault = (r, b, t = c.root, m) => request(origin, ca, r, b, t, m);
  const getToken = require(path.join(core, 'lib/secrets/vault-token-source')).tokenFileReader(path.join(out, 'private/sink/token'));
  const production = require(path.join(core, 'lib/secrets/vault-transit')).createVaultTransit({ address: origin, mount: 'transit', encryptionKey: 'tenant-data-operating', getToken, timeoutMs: 1500 });
  const plaintext = Buffer.from('synthetic-operating-proof');
  const observations = [], check = (name, detail = {}) => { observations.push({ name, ...detail }); write('observations.json', observations); };
  // The serving capability is decrypt only; tenant tokens are signed in process (decision deployment-signing-secret).
  async function sign () { need((await production.decrypt(c.ciphertext)).equals(plaintext), 'OPERATING_DECRYPT_ORACLE'); return true; }
  async function refused (name, code) { await assert.rejects(sign, e => e.code === code); check(name, { refused: code }); }
  async function lookup (token) { const response = await vault('auth/token/lookup-self', undefined, token, 'GET'); return response.status === 200 ? response.value.data : null; }
  function agent (verb) { return command('docker', [verb, c.agent]); }
  async function renewed () { return until(async () => { const t = await getToken(), x = await lookup(t); return x && t; }, 10000, 'OPERATING_AGENT_NO_RECOVERY'); }
  await sign(); check('production-transit-positive');
  let tlsError;
  try { await request(origin, fs.readFileSync(path.join(out, 'private/tls/wrong-ca.crt')), 'sys/health', undefined, undefined, 'GET'); } catch (e) { tlsError = e.code; }
  need(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(tlsError), 'OPERATING_WRONG_CA_NOT_REFUSED');
  check('wrong-ca-control', { refused: tlsError }); await sign(); check('tls-restored');
  const forbidden = await vault('transit/keys/tenant-data-operating', undefined, await getToken(), 'GET');
  need(forbidden.status === 403, 'OPERATING_KEY_MANAGEMENT_NOT_REFUSED'); check('private-key-management-refused', { status: forbidden.status });
  const first = await getToken(), start = await lookup(first); need(start?.renewable && start.ttl <= 4, 'OPERATING_TTL_CONTRACT');
  await until(async () => { const now = await getToken(); if (now !== first) return false; const x = await lookup(first); return x?.expire_time && Date.parse(x.expire_time) > Date.parse(start.expire_time); }, 6500, 'OPERATING_RENEWAL_UNMEASURED');
  await sign(); check('same-token-renewal', { tokenTtlSeconds: 4 });
  await until(async () => { const next = await getToken(); return next !== first && await lookup(next); }, 15000, 'OPERATING_MAX_TTL_UNMEASURED');
  await sign(); check('max-ttl-reauthentication', { maxTtlSeconds: 12 });
  // Real missing sink while a valid pre-existing credential remains in memory:
  // production reader must refuse; the application is never passed that token.
  agent('stop'); const heldToken = await getToken();
  const sink = path.join(out, 'private/sink/token'), held = path.join(out, 'private/sink/held'); fs.renameSync(sink, held);
  await refused('missing-sink-control', 'SECRETS_PROVIDER_UNAVAILABLE'); fs.renameSync(held, sink); await sign(); check('sink-restored');
  await until(async () => !await lookup(heldToken), 16000, 'OPERATING_EXPIRY_UNMEASURED');
  await refused('expired-token-control', 'SECRETS_PROVIDER_REFUSED');
  async function supplySecret () { const r = await vault('auth/approle/role/operating/secret-id', {}); need(r.status === 200, 'OPERATING_SECRET_REPLACEMENT'); fs.writeFileSync(path.join(out, 'private/creds/secret_id'), r.value.data.secret_id + '\n', { mode: 0o600 }); }
  await supplySecret(); agent('start'); await renewed(); await sign(); check('expiry-recovered-by-explicit-secret-id');
  agent('stop'); const revoked = await getToken(); need((await vault('auth/token/revoke', { token: revoked })).status === 204, 'OPERATING_REVOKE_FAILED');
  await refused('revoked-token-control', 'SECRETS_PROVIDER_REFUSED');
  await supplySecret(); agent('start'); await renewed(); await sign(); check('revocation-recovered-by-explicit-secret-id');
  need((await vault('sys/seal', {})).status === 204, 'OPERATING_SEAL_FAILED'); await refused('sealed-vault-control', 'SECRETS_PROVIDER_REFUSED');
  need((await vault('sys/unseal', { key: c.unseal })).value?.sealed === false, 'OPERATING_UNSEAL_FAILED'); await sign(); check('unsealed-restored');
  command('docker', ['stop', c.vault]); await refused('transport-outage-control', 'SECRETS_PROVIDER_UNAVAILABLE');
  command('docker', ['start', c.vault]);
  const actualPort=Number(command('docker',['inspect',c.vault,'--format','{{(index (index .NetworkSettings.Ports \"8200/tcp\") 0).HostPort}}']));write('endpoint.json',{before:c.port,after:actualPort,stable:c.port===actualPort});need(c.port===actualPort,'OPERATING_PORT_CHANGED');
  await until(async () => { try { const h = await vault('sys/health', undefined, undefined, 'GET'); return h.status === 503; } catch { return false; } }, 15000, 'OPERATING_RESTART_NOT_SEALED');
  need((await vault('sys/unseal', { key: c.unseal })).value?.sealed === false, 'OPERATING_RESTART_UNSEAL_FAILED');
  await until(async () => { try { await sign(); return true; } catch { return false; } }, 15000, 'OPERATING_TRANSPORT_RECOVERY'); check('transport-restored-after-unseal');
  check('private-sink-custody', { mode: (fs.statSync(sink).mode & 0o777).toString(8), secretIdConsumed: !fs.existsSync(path.join(out, 'private/creds/secret_id')) });
  need((fs.statSync(sink).mode & 0o777) === 0o600, 'OPERATING_SINK_MODE');
  write('proof.json', { verdict: 'PASS', scope: 'native-vault-agent-production-token-reader-and-transit-component', observations, unmeasured: ['selected deployment','API authorization','Vault HA','production human unseal custody','external identity or actual client journey','capacity'] });
}
async function main () {
  need(opts.core && opts.out && path.isAbsolute(opts.core) && path.isAbsolute(opts.out), 'OPERATING_ABSOLUTE_PATHS_REQUIRED');
  if (opts.phase === 'prove') return prove();
  need(!fs.existsSync(out), 'OPERATING_OUTPUT_EXISTS');
  const coreCommit = command('git', ['-C', core, 'rev-parse', 'HEAD']), deployCommit = command('git', ['-C', deploy, 'rev-parse', 'HEAD']);
  command('git', ['-C', core, 'diff', '--exit-code', '--', 'lib/secrets/vault-token-source.js', 'lib/secrets/vault-transit.js']);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const d of ['private','private/tls','private/creds','private/sink','private/vault-data']) fs.mkdirSync(path.join(out, d), { mode: 0o700 });
  const nonce = crypto.randomBytes(8).toString('hex'), label = 'nightscout.operations.owner=' + nonce, resources = { containers: [], network: null };
  const tls = name => path.join(out, 'private/tls', name);
  fs.copyFileSync(__filename, path.join(out, 'instrument.cjs')); fs.chmodSync(path.join(out, 'instrument.cjs'), 0o600);
  const imageId = command('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  write('source.json', { coreCommit, deployCommit, image: IMAGE, imageId, node: process.version, instrumentSha256: digest(fs.readFileSync(__filename)), agentHclSha256: digest(fs.readFileSync(path.join(deploy, 'bindings/compose/vault-agent/agent.hcl'))), sourceModules: Object.fromEntries(['vault-token-source.js','vault-transit.js'].map(n => [n,digest(fs.readFileSync(path.join(core, 'lib/secrets', n)))])), execution: 'shared host; isolated native component; 180-second child budget', nonce });
  function cleanup () {
    const result = [];
    for (const id of resources.containers.slice().reverse()) {
      const i = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 10000 });
      if (i.status === 0) { const row = JSON.parse(i.stdout)[0]; if (row.Id !== id || row.Config.Labels['nightscout.operations.owner'] !== nonce) { result.push({ id, refused: 'OWNERSHIP_MISMATCH' }); continue; } command('docker', ['rm', '-f', id]); }
      const absent = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 10000 }); result.push({ id, absent: absent.status !== 0 });
    }
    if (resources.network) { command('docker', ['network', 'rm', resources.network]); result.push({ network: resources.network, absent: spawnSync('docker', ['network','inspect',resources.network], { timeout:10000 }).status !== 0 }); resources.network = null; }
    write('cleanup.json', result);
  }
  process.once('SIGTERM', () => { cleanup(); process.exit(143); }); process.once('SIGINT', () => { cleanup(); process.exit(130); });
  try {
    for (const name of ['ca','wrong-ca']) command('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tls(name+'.key'),'-out',tls(name+'.crt'),'-days','1','-subj','/CN=synthetic-operating-'+name]);
    command('openssl', ['req','-newkey','rsa:2048','-nodes','-keyout',tls('vault.key'),'-out',tls('vault.csr'),'-subj','/CN=vault']);
    fs.writeFileSync(tls('vault.ext'), 'subjectAltName=DNS:vault,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', { mode:0o600 });
    command('openssl', ['x509','-req','-in',tls('vault.csr'),'-CA',tls('ca.crt'),'-CAkey',tls('ca.key'),'-CAcreateserial','-out',tls('vault.crt'),'-days','1','-extfile',tls('vault.ext')]);
    for (const name of fs.readdirSync(path.join(out,'private/tls'))) fs.chmodSync(tls(name), 0o600);
    const config = 'disable_mlock = true\nui = false\nstorage "file" { path = "/vault/file" }\nlistener "tcp" {\n address = "0.0.0.0:8200"\n tls_cert_file = "/run/ns-ca/vault.crt"\n tls_key_file = "/run/ns-ca/vault.key"\n}\n';
    fs.writeFileSync(path.join(out, 'private/server.hcl'), config, { mode:0o600 });
    resources.network = command('docker', ['network','create','--label',label,'ns-operating-'+nonce]); write('resources.json', resources);
    const selectedPort=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
    const vault = command('docker', ['run','-d','--name','ns-operating-vault-'+nonce,'--label',label,'--network',resources.network,'--network-alias','vault','--user','1000:1000','--read-only','--tmpfs','/tmp:mode=1777','--mount','type=bind,src='+path.join(out,'private/vault-data')+',dst=/vault/file','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpus','0.5','--memory','384m','-p','127.0.0.1:'+selectedPort+':8200','--mount','type=bind,src='+path.join(out,'private/tls')+',dst=/run/ns-ca,readonly','--mount','type=bind,src='+path.join(out,'private/server.hcl')+',dst=/run/server.hcl,readonly','--entrypoint','vault',IMAGE,'server','-config=/run/server.hcl']);
    resources.containers.push(vault); write('resources.json', resources);
    const port = Number(command('docker',['inspect',vault,'--format','{{(index (index .NetworkSettings.Ports "8200/tcp") 0).HostPort}}']));
    const origin = 'https://localhost:'+port, ca = fs.readFileSync(tls('ca.crt'));
    await until(async () => { try { return (await request(origin,ca,'sys/health',undefined,undefined,'GET')).status===501; } catch { return false; } },15000,'OPERATING_VAULT_START');
    const initialized = await request(origin,ca,'sys/init',{secret_shares:1,secret_threshold:1}); need(initialized.status===200,'OPERATING_INIT_FAILED');
    const root = initialized.value.root_token, unseal = initialized.value.keys_base64[0], admin = (r,b,m) => request(origin,ca,r,b,root,m);
    need((await admin('sys/unseal',{key:unseal})).value?.sealed===false,'OPERATING_FIRST_UNSEAL');
    need((await admin('sys/mounts/transit',{type:'transit'})).status===204,'OPERATING_TRANSIT_MOUNT');
    for(const [name,type] of [['tenant-data-operating','aes256-gcm96']]) { const r=await admin('transit/keys/'+name,{type}); need([200,204].includes(r.status),'OPERATING_KEY_CREATE'); }
    const policy = require(path.join(deploy, 'bindings/compose/vault-agent/vault-agent-bootstrap')).policyRules({mount:'transit',prefix:'operating'},'registry');
    need((await admin('sys/policies/acl/operating',{policy},'PUT')).status===204,'OPERATING_POLICY_CREATE');
    need((await admin('sys/auth/approle',{type:'approle'})).status===204,'OPERATING_APPROLE_ENABLE');
    need((await admin('auth/approle/role/operating',{token_policies:['operating'],token_no_default_policy:true,token_type:'service',token_ttl:'4s',token_max_ttl:'12s',secret_id_ttl:0,secret_id_num_uses:0})).status===204,'OPERATING_ROLE_CREATE');
    const role = await admin('auth/approle/role/operating/role-id',undefined,'GET'), secret = await admin('auth/approle/role/operating/secret-id',{});
    for(const [name,value] of [['role_id',role.value?.data?.role_id],['secret_id',secret.value?.data?.secret_id]]) { need(typeof value==='string','OPERATING_LOGIN_MATERIAL'); fs.writeFileSync(path.join(out,'private/creds',name),value+'\n',{mode:0o600}); }
    const agent = command('docker',['run','-d','--name','ns-operating-agent-'+nonce,'--label',label,'--network',resources.network,'--user','1000:1000','--read-only','--tmpfs','/tmp:mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpus','0.25','--memory','128m','--mount','type=bind,src='+path.join(out,'private/creds')+',dst=/run/ns-vault-creds','--mount','type=bind,src='+path.join(out,'private/sink')+',dst=/run/ns-vault','--mount','type=bind,src='+tls('ca.crt')+',dst=/run/ns-ca/ca.crt,readonly','--mount','type=bind,src='+path.join(deploy,'bindings/compose/vault-agent/agent.hcl')+',dst=/run/agent.hcl,readonly','--entrypoint','vault',IMAGE,'agent','-config=/run/agent.hcl']);
    resources.containers.push(agent); write('resources.json', resources);
    await until(async () => fs.existsSync(path.join(out,'private/sink/token')),10000,'OPERATING_AGENT_START');
    const encrypted=await admin('transit/encrypt/tenant-data-operating',{plaintext:Buffer.from('synthetic-operating-proof').toString('base64')}); need(typeof encrypted.value?.data?.ciphertext==='string','OPERATING_CIPHERTEXT_SEED');
    fs.writeFileSync(path.join(out,'private/context.json'),JSON.stringify({port,vault,agent,root,unseal,ciphertext:encrypted.value.data.ciphertext}),{mode:0o600});
    const r = spawnSync(process.execPath,[__filename,'--core',core,'--out',out,'--phase','prove'],{env:{...process.env,NODE_EXTRA_CA_CERTS:tls('ca.crt')},encoding:'utf8',timeout:180000,maxBuffer:1048576});
    fs.writeFileSync(path.join(out,'private/child.stdout'),r.stdout||'',{mode:0o600}); fs.writeFileSync(path.join(out,'private/child.stderr'),r.stderr||'',{mode:0o600});
    if (r.error || r.status !== 0) { const code=(r.stderr||'').trim(); throw fail(/^[A-Z0-9_]{1,100}$/.test(code)?code:'OPERATING_NATIVE_PROOF_FAILED'); }
    need(command('git',['-C',core,'rev-parse','HEAD'])===coreCommit && command('git',['-C',deploy,'rev-parse','HEAD'])===deployCommit, 'OPERATING_SOURCE_CHANGED');
  } catch(e) { for (const id of resources.containers) { const l=spawnSync('docker',['logs',id],{encoding:'utf8',timeout:10000,maxBuffer:1048576});fs.writeFileSync(path.join(out,'private/container-'+id.slice(0,12)+'.log'),(l.stdout||'')+(l.stderr||''),{mode:0o600}); } write('failure.json',{code:e.code||e.message,command:e.command,status:e.status,causeCode:e.causeCode}); throw e; }
  finally { cleanup(); }
}
main().then(()=>console.log(JSON.stringify({verdict:'PASS',output:out,scope:'component-only'}))).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
