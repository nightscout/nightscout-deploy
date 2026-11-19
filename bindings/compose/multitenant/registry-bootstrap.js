'use strict';

// Infrastructure only. Tenant rows and keys are provisioned later through the
// admin REST API; lab subjects and data are a separate API client job.
const path = require('node:path');
async function finish({ options, request, rootToken, layout, roleURLs, writePrivate, admin, adminURL, nativeSource }) {
  const plan = require('./config'), { output, uid, gid, sourceCommit, configMaxBytes } = options;
  const l = layout, own = { uid, gid }, compact = { compact: true };
  const fs = require('node:fs');
  function writeToken(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' });
    fs.chownSync(path.dirname(file), uid, gid); fs.chownSync(file, uid, gid);
  }
  await request('sys/mounts/' + l.mount, { type: 'transit' }, rootToken);
  async function token(name, rules) {
    await request('sys/policies/acl/' + l.prefix + '_' + name, { policy: rules.join('\n') }, rootToken);
    return (await request('auth/token/create', { policies: [l.prefix + '_' + name], no_default_policy: true, renewable: true, ttl: '24h' }, rootToken)).auth.client_token;
  }
  const rule = (route, caps) => 'path "' + l.mount + '/' + route + '" { capabilities = [' + caps.map(cap => '"' + cap + '"').join(',') + '] }';
  const servingToken = await token('api', [rule('decrypt/tenant-data-*', ['update']), rule('hmac/tenant-signing-*', ['update']), rule('verify/tenant-signing-*', ['update']), rule('sign/tenant-access-*', ['update'])]);
  const ownerCredentialToken=await token('owner-credentials',[rule('decrypt/tenant-data-*',['update'])]);
  const managementToken = await token('management-issuer', [rule('keys/tenant-management-*', ['read']), rule('sign/tenant-management-*', ['update'])]);
  const provisioningToken = await token('provisioner', [rule('keys/tenant-*', ['create','read','update']), rule('encrypt/tenant-data-*', ['update'])]);
  const realtimeOwnership = require('./realtime-workers').initial(require('./realtime-workers').selection());
  const docs = plan.documents({ layout: l, urls: roleURLs, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: options.vault.origin, registryMode: true, realtimeOwnership });
  let nativeSelection;
  if(nativeSource){
    const binding=require('./native-lifecycle');nativeSelection=binding.select(l,docs,nativeSource);
    await binding.install({admin,adminURL,layout:l,selection:nativeSelection});
    binding.attach(docs,nativeSelection);
  }
  for (const role of Object.keys(docs.configs)) {
    const dir = path.join(output, role);
    writePrivate(path.join(dir, 'env.json'), docs.environments[role], own, compact);
    writePrivate(path.join(dir, 'config.json'), docs.configs[role], own, compact);
    if(role==='tenant-admin')writeToken(path.join(dir,'vault-token'),ownerCredentialToken);
    if(role==='evaluator'&&docs.configs[role].pgstream)writePrivate(path.join(output,'pgstream','pgstream.yaml'),require('./pgstream').wire(docs.configs[role],roleURLs.pgstream,{assignment:docs.environments[role].NS_PGSTREAM_EVALUATOR_SLICE===undefined?undefined:JSON.parse(docs.environments[role].NS_PGSTREAM_EVALUATOR_SLICE)}),own,compact);
    writePrivate(path.join(dir, 'operation.json'), docs.operations[role], own, compact);
    if (role === 'api' || role.startsWith('api-')) {
      writeToken(path.join(dir, 'vault-token'), servingToken);
      writePrivate(path.join(dir, 'evaluator-metadata.json'), docs.configs.evaluator, own, compact);
    }
  }
  require('./platform-startup').files({ output, docs, writePrivate, own, compact });
  writePrivate(path.join(output, 'admin', 'env.json'), docs.admin.environment, own, compact);
  writePrivate(path.join(output, 'admin', 'config.json'), docs.admin.config, own, compact);
  writeToken(path.join(output, 'admin', 'vault-token'), provisioningToken);
  writeToken(path.join(output, 'admin', 'management-vault-token'), managementToken);
  writePrivate(path.join(output, 'ui', 'config.json'), docs.ui, own, compact);
  writePrivate(path.join(output, 'ui', 'env.json'), docs.uiEnvironment, own, compact);
  const source = configMaxBytes === undefined ? docs : { ...docs, environments: Object.fromEntries(Object.entries(docs.environments).map(([role, env]) => [role, { ...env, MULTITENANT_CONFIG_MAX_BYTES: String(configMaxBytes) }])) };
  plan.validateFiles(output, source);
  require('../../lib/server/serve/admin-config').parse(docs.admin.config, docs.admin.environment);
  const ids = plan.tenantIds();
  const seed = ids.map((id, index) => ({ id, hosts: [plan.tenantAlias(index)], issueRootSecret: true }));
  writePrivate(path.join(output, 'primer', 'config.json'), { version: 1, adminOrigin: 'http://admin:1342', apiOrigin: docs.apiOrigin || 'http://api:1337', ownerConsumer: docs.configs['tenant-admin'].management.consumer, platformVerification: require('./platform-startup').selection(docs), seed }, own);
  const lifecycle = plan.lifecycle(l);
  writePrivate(path.join(output, 'ops', 'config.json'), { version: nativeSelection?2:1, drainTimeoutMs: 10000,
    tenants: ids.map((id, i) => ({ id, host: plan.tenantAlias(i), tokenEnv: i === 0 ? 'NS_DEMO_TOKEN_A' : i === 1 ? 'NS_DEMO_TOKEN_B' : 'NS_DEMO_TOKEN_' + i })),
    ...(nativeSelection?{nativeSelection:structuredClone(nativeSelection.binding),evaluatorProof:require('./operator-selection').inputs(docs,nativeSelection)}:{}),
    apiOrigin: docs.apiOrigin || 'http://api:1337', control: { namespace: l.namespaces.control, registry: { namespace: l.namespaces.registry }, locks: docs.locks }, ...lifecycle }, own);
  writePrivate(path.join(output, 'ops', 'env.json'), { NS_OPERATOR_PG: roleURLs.operator, NS_AUTH_AUDIT_PG:roleURLs.api, NS_SOURCE_COMMIT: sourceCommit,
     }, own);
  writeToken(path.join(output,'ops','vault-token'), servingToken);
  writePrivate(path.join(output, 'bootstrap', 'layout.json'), l);
  writePrivate(path.join(output, 'bootstrap', 'complete.json'), { version: 2, sourceCommit, deployCommit: options.deployCommit, registryMode: true, evaluatorWorkers: docs.evaluatorWorkers?.workers });
  return { state: 'synthetic-infrastructure-ready', sourceCommit };
}
module.exports = { finish };
