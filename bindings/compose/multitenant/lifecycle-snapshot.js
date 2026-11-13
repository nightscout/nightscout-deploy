'use strict';
// Companion-private snapshot over the entry's ONE admitted backend. No Pool
// constructor, startup acquire, replacement backend or core injection API.
const {AsyncLocalStorage}=require('node:async_hooks');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function create(context){
 need(require('./lifecycle-operator-entry').isContext(context),'LIFECYCLE_OPERATOR_CONTEXT');
 const scope=require('../../lib/storage/tenant-scope'),transactions=new AsyncLocalStorage();
 let used=false;
 function tenant(){const value=scope.requireTenant('admitted capture snapshot');need(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)&&value!=='00000000-0000-0000-0000-000000000000','LIFECYCLE_SNAPSHOT_TENANT');return value;}
 function active(){context.check();const tx=transactions.getStore();need(tx&&tx.active&&tenant()===tx.tenant,'LIFECYCLE_SNAPSHOT_SCOPE');if(tx.error)throw tx.error;return tx;}
 async function query(text,values){const tx=active(),result=await tx.client.query(text,values);active();return result;}
 return Object.freeze({query,async snapshotTransaction(fn){
  const id=tenant();context.check();need(!transactions.getStore(),'LIFECYCLE_SNAPSHOT_NESTED');need(!used,'LIFECYCLE_SNAPSHOT_SECOND_ACQUIRE');used=true;
  const client=await context.pool.connect(),tx={client,tenant:id,active:true,error:null};let releaseError;
  const failed=error=>{if(!tx.error)tx.error=error;};client.on('error',failed);
  try{return await transactions.run(tx,async()=>{
   const role=await query('SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user');
   need(role.rows.length===1&&role.rows[0].rolsuper===false&&role.rows[0].rolbypassrls===false,'LIFECYCLE_SNAPSHOT_RLS_PRINCIPAL');
   try{
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await query("SELECT set_config('app.current_tenant_id', $1, true)",[id]);
    const result=await fn();active();const committed=await query('COMMIT');need(committed.command==='COMMIT','LIFECYCLE_SNAPSHOT_ABORTED');return result;
   }catch(error){
    try{context.check();await client.query('ROLLBACK');context.check();}catch(rollbackError){releaseError=rollbackError;const failure=Object.assign(new Error('LIFECYCLE_SNAPSHOT_ROLLBACK_FAILED'),{code:'LIFECYCLE_SNAPSHOT_ROLLBACK_FAILED',cause:error,rollbackError});throw failure;}
    throw error;
   }
  });}finally{tx.active=false;try{client.release(releaseError||tx.error);}finally{client.removeListener('error',failed);}}
 }});
}
module.exports={create};
