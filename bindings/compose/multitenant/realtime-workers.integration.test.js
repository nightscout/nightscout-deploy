'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('each static replica mounts only its role credentials', t=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'ns-static-replicas-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const before={NS_API_REPLICAS:process.env.NS_API_REPLICAS,NS_REALTIME_WORKERS:process.env.NS_REALTIME_WORKERS};
  Object.assign(process.env,{NS_API_REPLICAS:'2',NS_REALTIME_WORKERS:'2'});
  t.after(()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const credentials=path.join(state,'credentials');require('./credentials').seed(credentials);
  const render=require('./render');render.render(render.input({NS_RENDER_OUTPUT:state,NS_CREDENTIALS_DIR:credentials}));
  for(const name of ['api','realtime']){
    const files=fs.readdirSync(path.join(state,name)).sort();
    assert.deepEqual(fs.readdirSync(path.join(state,name+'-2')).sort(),files);
    for(const file of files)assert.deepEqual(fs.readFileSync(path.join(state,name,file)),fs.readFileSync(path.join(state,name+'-2',file)));
  }
});
