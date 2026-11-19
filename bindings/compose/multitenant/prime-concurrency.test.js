'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {prime,provision,add,parsePrimeOptions}=require('./prime');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const write=(dir,name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value),{mode:0o600});
const read=(dir,name)=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
async function fixture(count,run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-primer-concurrency-'));
 const rows=Array.from({length:count},(_,i)=>({id:'10000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),hosts:['tenant-'+i+'.example.test'],rootSecret:crypto.randomBytes(20).toString('hex')}));
 const calls=[],entries=new Map(),tokens=new Map(rows.map(row=>[row.id,crypto.randomBytes(20).toString('hex')]));let behavior=async()=>undefined,active=0,peak=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const row=rows.find(row=>row.hosts[0]===req.headers.host),call={path:req.url,method:req.method,host:req.headers.host,headers:req.headers,body:raw?JSON.parse(raw):undefined,row};calls.push(call);
  if(call.path==='/api/v2/authorization/roles'){active++;peak=Math.max(peak,active);}
  let response=await behavior(call,{res,entries});
  if(res.destroyed)return;
  if(response===undefined){
   if(call.path==='/api/v2/authorization/roles')response={status:200,body:[{name:'demo'}]};
   else if(call.path==='/api/v2/authorization/subjects')response={status:200,body:[{name:'Synthetic demo uploader',_id:'uploader_'+row.id,accessToken:tokens.get(row.id)},{name:'Synthetic demo owner',_id:'owner_'+row.id}]};
   else if(call.path==='/ownership/list')response={status:200,body:{outcome:'listed',owners:[{principal:'owner_'+call.body.tenant,consumer:'test-owner'}]}};
   else if(call.path.endsWith('/management-sessions'))response={status:200,body:{token:crypto.randomBytes(20).toString('hex'),expiresAt:2000000000}};
   else if(call.path==='/api/v1/entries'){entries.set(row.id,(entries.get(row.id)||0)+1);response={status:200,body:[]};}
   else response={status:403,body:{}};
  }
  if(call.path==='/api/v1/entries'||(call.path==='/api/v2/authorization/roles'&&response.status!==200))active--;
  res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify(response.body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 write(dir,'provisioned.json',rows);
 try{await run({dir,rows,calls,entries,tokens,config:{adminOrigin:origin,apiOrigin:origin,ownerConsumer:'test-owner'},behavior:fn=>{behavior=fn;},peak:()=>peak});}
 finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
test('bounded workers preserve each tenant API identity, durable order and completed reuse',async()=>fixture(8,async x=>{
 x.behavior(async call=>{if(call.path==='/api/v2/authorization/roles')await sleep(15);});
 assert.equal((await prime(x.config,x.dir,{concurrency:3})).tenants,8);assert.equal(x.peak(),3);
 assert.deepEqual(read(x.dir,'tenants.json').tenants.map(row=>row.id),x.rows.map(row=>row.id));
 assert.ok([...x.entries.values()].every(value=>value===1));assert.equal(x.entries.size,8);
 for(const call of x.calls.filter(call=>call.path.startsWith('/api/'))){assert.ok(call.row);assert.equal(call.headers['api-secret'],call.path==='/api/v1/entries'?x.tokens.get(call.row.id):crypto.createHash('sha1').update(call.row.rootSecret).digest('hex'));}
 assert.ok(x.calls.filter(call=>call.path==='/ownership/list').every(call=>x.rows.some(row=>row.id===call.body.tenant)));
 assert.deepEqual(read(x.dir,'entry-requests.json'),{version:1,tenants:{}});assert.equal(fs.existsSync(path.join(x.dir,'prime.lock')),false);
 const before=x.calls.length;await prime(x.config,x.dir,{concurrency:3});assert.equal(x.calls.length,before);
}));
test('first tenant refusal stops dispatch but drains and saves its already-active peer',async()=>fixture(4,async x=>{
 x.behavior(async call=>{if(call.path==='/api/v2/authorization/roles'){if(call.row===x.rows[0])return{status:403,body:{}};await sleep(40);}});
 await assert.rejects(prime(x.config,x.dir,{concurrency:2}),{code:'PRIMER_DATA_API_REFUSED_403'});
 assert.deepEqual(read(x.dir,'tenants.json').tenants.map(row=>row.id),[x.rows[1].id]);
 assert.equal(x.calls.filter(call=>call.path==='/api/v2/authorization/roles').length,2);assert.equal(x.entries.get(x.rows[1].id),1);
 x.behavior(async()=>undefined);await prime(x.config,x.dir,{concurrency:2});assert.equal(x.entries.get(x.rows[1].id),1);assert.equal(x.entries.size,4);
}));
test('bounded chunks resume without repeating completed tenants or sealing a partial seed',async()=>fixture(5,async x=>{
 assert.deepEqual(await prime(x.config,x.dir,{concurrency:2,maxTenants:2}),{state:'synthetic-data-prime-partial',tenants:2,remaining:3});
 assert.equal(fs.existsSync(path.join(x.dir,'primed.json')),false);
 assert.equal((await prime(x.config,x.dir,{concurrency:2,maxTenants:2})).remaining,1);
 assert.deepEqual(await prime(x.config,x.dir),{state:'synthetic-data-primed',tenants:5});assert.ok([...x.entries.values()].every(value=>value===1));
}));
test('cancellation stops new dispatch and returns only after active tenants are saved',async()=>fixture(5,async x=>{
 const controller=new AbortController();
 x.behavior(async call=>{if(call.path==='/api/v2/authorization/roles'){controller.abort();await sleep(15);}});
 assert.deepEqual(await prime(x.config,x.dir,{concurrency:2,signal:controller.signal}),{state:'synthetic-data-prime-partial',tenants:2,remaining:3});
 const before=x.calls.length;await sleep(25);assert.equal(x.calls.length,before);assert.equal(read(x.dir,'tenants.json').tenants.length,2);
 x.behavior(async()=>undefined);await prime(x.config,x.dir,{concurrency:2});assert.ok([...x.entries.values()].every(value=>value===1));
}));
test('accepted entry with lost response fences resume instead of issuing a second POST',async()=>fixture(2,async x=>{
 x.behavior(async(call,{res,entries})=>{
  if(call.path==='/api/v1/entries'&&call.row===x.rows[0]){assert.doesNotMatch(call.body._id,/^[a-f0-9]{24}$/);entries.set(call.row.id,1);res.destroy();}
  if(call.path==='/api/v2/authorization/roles'&&call.row===x.rows[1])await sleep(20);
 });
 await assert.rejects(prime(x.config,x.dir,{concurrency:2}),{code:'PRIMER_CONNECTION_FAILED'});
 assert.deepEqual(read(x.dir,'tenants.json').tenants.map(row=>row.id),[x.rows[1].id]);
 assert.equal(read(x.dir,'entry-requests.json').tenants[x.rows[0].id].state,'outcome-uncertain');
 const before=x.calls.length;await assert.rejects(prime(x.config,x.dir,{concurrency:2}),{code:'PRIMER_ENTRY_OUTCOME_UNCERTAIN'});assert.equal(x.calls.length,before);assert.equal(x.entries.get(x.rows[0].id),1);
}));
test('only one process or invocation owns a primer directory',async()=>fixture(1,async x=>{
 let release,entered;const inside=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 x.behavior(async call=>{if(call.path==='/api/v2/authorization/roles'){entered();await gate;}});
 const first=prime(x.config,x.dir);await inside;
 await assert.rejects(prime(x.config,x.dir),{code:'PRIMER_STATE_IN_USE'});await assert.rejects(provision(x.config,x.dir),{code:'PRIMER_STATE_IN_USE'});await assert.rejects(add(x.config,x.dir),{code:'PRIMER_STATE_IN_USE'});release();await first;
 write(x.dir,'prime.lock',{version:1,pid:2147483647,nonce:'synthetic-stale-lock'});const before=x.calls.length;
 await assert.rejects(prime(x.config,x.dir),{code:'PRIMER_STATE_IN_USE'});assert.equal(x.calls.length,before);
}));
test('default remains serial; invalid bounds, duplicate identities and unknown CLI options refuse before traffic',async()=>fixture(3,async x=>{
 for(const options of [{concurrency:0},{concurrency:33},{maxTenants:0},{maxTenants:1.5},{concurrency:1.5},{other:1}])await assert.rejects(prime(x.config,x.dir,options),{code:'PRIMER_OPTIONS_INVALID'});
 for(const values of [['--concurrency','0'],['--concurrency','2','--concurrency','3'],['--other','2'],['--max-tenants']])assert.throws(()=>parsePrimeOptions(values),{code:'PRIMER_OPTIONS_INVALID'});
 assert.equal(x.calls.length,0);write(x.dir,'provisioned.json',[x.rows[0],x.rows[0]]);
 await assert.rejects(prime(x.config,x.dir,{concurrency:2}),{code:'PRIMER_CUSTODY_INVALID'});assert.equal(x.calls.length,0);
 write(x.dir,'provisioned.json',x.rows);x.behavior(async call=>{if(call.path==='/api/v2/authorization/roles')await sleep(5);});await prime(x.config,x.dir);assert.equal(x.peak(),1);
 assert.deepEqual(parsePrimeOptions(['--concurrency','4','--max-tenants','100']),{concurrency:4,maxTenants:100});
}));
test('custody flush failures fence both dispatch and uncertain completed-entry persistence',async()=>{
 for(const phase of ['entry-requests.json.new','tenants.json.new'])await fixture(1,async x=>{
  const sync=fs.fsyncSync;fs.fsyncSync=fd=>{if(fs.readlinkSync('/proc/self/fd/'+fd)===path.join(x.dir,phase))throw Object.assign(new Error('synthetic fsync refusal'),{code:'EIO'});return sync(fd);};
  try{await assert.rejects(prime(x.config,x.dir),{code:'EIO'});}finally{fs.fsyncSync=sync;}
  if(phase==='entry-requests.json.new')assert.equal(x.entries.size,0,'no POST before uncertainty marker is flushed');
  else{assert.equal(x.entries.get(x.rows[0].id),1);assert.equal(read(x.dir,'entry-requests.json').tenants[x.rows[0].id].state,'outcome-uncertain');const before=x.calls.length;await assert.rejects(prime(x.config,x.dir),{code:'PRIMER_ENTRY_OUTCOME_UNCERTAIN'});assert.equal(x.calls.length,before);}
 });
});

function oneSecondStall(t) {
  const previous = process.env.NS_PRIMER_STALL_SECONDS;
  process.env.NS_PRIMER_STALL_SECONDS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.NS_PRIMER_STALL_SECONDS;
    else process.env.NS_PRIMER_STALL_SECONDS = previous;
  });
}

test('the DATA seed outlasts its stall window while each tenant saves custody', async t => {
  oneSecondStall(t);
  await fixture(4, async x => {
    x.behavior(async call => {
      if (call.path === '/api/v2/authorization/roles') await sleep(350);
    });
    const counts = [];
    const started = performance.now();
    const result = await prime(x.config, x.dir, {}, count => {
      if (count) assert.equal(read(x.dir, 'tenants.json').tenants.length, count);
      counts.push(count);
    });
    assert.equal(result.state, 'synthetic-data-primed');
    assert.deepEqual(counts, [0, 1, 2, 3, 4]);
    assert.ok(performance.now() - started > 1000);
    assert.deepEqual([...x.entries.values()], [1, 1, 1, 1]);
  });
});

test('repeated warming stalls with the last completed count; resume only sends pending tenants', async t => {
  oneSecondStall(t);
  await fixture(3, async x => {
    let retries = 0;
    x.behavior(async call => {
      if (call.path === '/api/v2/authorization/roles' && call.row === x.rows[1] && ++retries < 9) {
        return {status:503, body:{error:'TENANT_WARMING'}};
      }
    });
    await assert.rejects(prime(x.config, x.dir), {code:'PRIMER_STALLED', tenants:1});
    assert.ok(retries > 1);
    assert.equal(fs.existsSync(path.join(x.dir, 'prime.lock')), false);
    const completed = read(x.dir, 'tenants.json').tenants;
    assert.equal(completed.length, 1);
    x.behavior(async () => undefined);
    const callCount = x.calls.length;
    const counts = [];
    assert.equal((await prime(x.config, x.dir, {concurrency:2}, count => counts.push(count))).tenants, 3);
    assert.deepEqual(counts, [1, 2, 3]);
    assert.deepEqual(read(x.dir, 'tenants.json').tenants[0], completed[0]);
    assert.ok(x.calls.slice(callCount).every(call => call.row !== x.rows[0]));
    assert.deepEqual([...x.entries.values()], [1, 1, 1]);
  });
});

test('a stall after an entry POST retains the uncertainty fence on retry', async t => {
  oneSecondStall(t);
  await fixture(2, async x => {
    x.behavior(async (call, {entries}) => {
      if (call.path === '/api/v1/entries' && call.row === x.rows[1]) {
        entries.set(call.row.id, 1);
        await sleep(1500);
        return {status:200, body:[]};
      }
    });
    await assert.rejects(prime(x.config, x.dir), {code:'PRIMER_STALLED', tenants:1});
    assert.equal(fs.existsSync(path.join(x.dir, 'prime.lock')), false);
    assert.equal(read(x.dir, 'entry-requests.json').tenants[x.rows[1].id].state, 'outcome-uncertain');
    const before = x.calls.length;
    await assert.rejects(prime(x.config, x.dir), {code:'PRIMER_ENTRY_OUTCOME_UNCERTAIN'});
    assert.equal(x.calls.length, before);
    assert.deepEqual([...x.entries.values()], [1, 1]);
  });
});

test('provision renews on saved batches and resumes past whole completed batches', async t => {
  oneSecondStall(t);
  await fixture(401, async x => {
    write(x.dir, 'provisioned.json', []);
    const seed = x.rows.map(({id, hosts}) => ({id, hosts, issueRootSecret:true}));
    const registry = new Set();
    let delayLastBatch = true;
    x.behavior(async (call, {res}) => {
      assert.equal(call.path, '/v1/tenants/batch');
      const {tenants} = call.body;
      await sleep(delayLastBatch && tenants[0].id === seed[300].id ? 1500 : 350);
      if (res.destroyed) return;
      const results = tenants.map(({id}) => {
        if (registry.has(id)) return {id, outcome:'existing'};
        registry.add(id);
        return {id, outcome:'created', rootSecret:'synthetic-' + id};
      });
      return {status:200, body:{results}};
    });
    await assert.rejects(provision({...x.config, seed}, x.dir), {code:'PRIMER_STALLED', tenants:300});
    const saved = read(x.dir, 'provisioned.json');
    assert.equal(saved.length, 300);
    assert.equal(fs.existsSync(path.join(x.dir, 'prime.lock')), false);
    delayLastBatch = false;
    const before = x.calls.length;
    assert.equal((await provision({...x.config, seed}, x.dir)).tenants, 401);
    assert.deepEqual(x.calls.slice(before).flatMap(call => call.body.tenants), seed.slice(300));
    assert.deepEqual(read(x.dir, 'provisioned.json').slice(0, 300), saved);
    assert.equal(registry.size, 401);
  });
});
