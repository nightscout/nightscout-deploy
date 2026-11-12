'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const state=process.env.NS_SHIPPING_LIVE_ADD_STATE;
test('shipping registry/admin new tenant partial failure, explicit resume and existing tenant isolation',{skip:!state,timeout:180000},()=>{
 const core=process.env.NS_SHIPPING_LIVE_ADD_CORE,project=process.env.NS_SHIPPING_LIVE_ADD_PROJECT,image=process.env.NS_SHIPPING_LIVE_ADD_IMAGE;
 assert.ok(path.isAbsolute(core||''));assert.ok(path.isAbsolute(state));assert.match(project||'',/^ns-live-add-proof-[0-9]{8}(?:-[a-z0-9]{1,16})?$/);assert.match(image||'',/^sha256:[a-f0-9]{64}$/);
 const source=JSON.parse(fs.readFileSync(path.join(state,'bootstrap/complete.json')));assert.equal(source.registryMode,true);
 const files=require('./fixtures/shipping-compose-files.cjs').files({core,state});const base=['compose','--project-name',project,'--env-file',path.join(core,'deploy/multitenant/.env'),...files.flatMap(file=>['-f',file])];
 const run=args=>execFileSync('docker',args,{encoding:'utf8',timeout:170000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
 const admin=run([...base,'ps','-q','admin']).trim();assert.match(admin,/^[a-f0-9]{12,64}$/);const inspected=JSON.parse(run(['inspect',admin]))[0];assert.equal(inspected.Image,image);assert.equal(inspected.Config.Labels['com.docker.compose.project'],project);assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'],source.sourceCommit);assert.equal(inspected.Config.Labels['org.nightscout.deploy.revision'],source.deployCommit);
 const result=run([...base,'--profile','ops','run','--rm','--no-deps','-e','NS_SHIPPING_LIVE_ADD_ACK=synthetic-disposable-only','primer','node','deploy/multitenant/fixtures/shipping-live-add.cjs']);
 const summary=JSON.parse(result.trim().split('\n').at(-1));assert.equal(summary.state,'passed');assert.equal(summary.newTenants,1);console.log(JSON.stringify(summary));
});
