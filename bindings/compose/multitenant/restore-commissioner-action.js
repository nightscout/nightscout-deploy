'use strict';
// Fixed admitted DDL-principal action. Config is a sealed host file, never an
// operator intent. No constructor/credential/grant or ordinary operator route.
const {isDeepStrictEqual:equal}=require('node:util');
const C=require('./control-recovery');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...keys].sort());
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v)&&v!=='public'&&v!=='information_schema'&&!v.startsWith('pg_');
const q=v=>'"'+v+'"';
function config(value){
 need(exact(value,['version','operatorPrincipal','tenants','namespace','registryNamespace'])&&value.version===1&&name(value.namespace)&&name(value.registryNamespace)&&value.namespace!==value.registryNamespace&&Array.isArray(value.tenants)&&value.tenants.length===2&&new Set(value.tenants).size===2&&value.tenants.every(t=>typeof t==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(t)&&t!=='00000000-0000-0000-0000-000000000000'),'RESTORE_COMMISSION_CONFIG');
 C.principal(value.operatorPrincipal);return structuredClone(value);
}
async function run(context,value){
 need(require('./lifecycle-operator-entry').isContext(context)&&context.class==='restore-commissioner','RESTORE_COMMISSION_CONTEXT');
 const fixed=config(value);context.check();
 const client=await context.pool.connect(),before=[],after=[];let authority;let releaseError,primary,commitDispatched=false;
 // Events outside an active query are still execution failures.
 const failed=error=>{primary=primary||error;};client.on('error',failed);
 const query=async(...args)=>{context.check();if(primary)throw primary;const result=await client.query(...args);context.check();if(primary)throw primary;return result;};
 try{
  authority=await require('./restore-commissioner-authority').verify(client,fixed,context.principal);context.check();
  await query('BEGIN');
  const roles=(await query('SELECT oid::text AS oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_catalog.pg_roles WHERE rolname=$1',[fixed.operatorPrincipal.role])).rows;
  need(roles.length===1&&roles[0].oid===fixed.operatorPrincipal.roleOid&&['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication'].every(k=>roles[0][k]===false),'RESTORE_COMMISSION_ROLE_REFUSED');
  for(const tenant of fixed.tenants){
   await query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
   const active=(await query('SELECT r.state,w.phase FROM '+q(fixed.registryNamespace)+'.tenant_registry r JOIN '+q(fixed.namespace)+'.tenant_lifecycle_windows w USING(tenant_id) WHERE r.tenant_id=$1',[tenant])).rows;
   need(active.length===1&&active[0].state==='active'&&active[0].phase==='active','RESTORE_COMMISSION_TENANT_REFUSED');
   const table=q(fixed.namespace)+'.tenant_lifecycle_restore_authority';
   const prior=(await query('SELECT active FROM '+table+' WHERE tenant_id=$1 AND role_oid=$2',[tenant,fixed.operatorPrincipal.roleOid])).rows;
   need(prior.length<=1&&(!prior.length||prior[0].active===true),'RESTORE_COMMISSION_REVOKED');
   before.push({tenant,roleOid:fixed.operatorPrincipal.roleOid,present:prior.length===1,active:prior.length===1?prior[0].active:null});
   if(!prior.length){const inserted=await query('INSERT INTO '+table+' (tenant_id,role_oid,active) VALUES ($1,$2,true)',[tenant,fixed.operatorPrincipal.roleOid]);need(inserted.rowCount===1,'RESTORE_COMMISSION_WRITE_COUNT');}
   after.push({tenant,roleOid:fixed.operatorPrincipal.roleOid,present:true,active:true});
  }
  commitDispatched=true;const committed=await query('COMMIT');need(committed.command==='COMMIT','RESTORE_COMMISSION_ABORTED');
  return {state:'synthetic-restore-authority-commissioned',operatorPrincipal:fixed.operatorPrincipal,authority,before,after};
 }catch(error){
  try{context.check();await client.query('ROLLBACK');context.check();}catch(rollbackError){releaseError=rollbackError;error.rollbackError=rollbackError;}
  if(commitDispatched||releaseError)throw Object.assign(new Error('RESTORE_COMMISSION_OUTCOME_UNCERTAIN'),{code:'RESTORE_COMMISSION_OUTCOME_UNCERTAIN',cause:error});
  throw error;
 }finally{try{client.release(releaseError||primary);}finally{client.removeListener('error',failed);}}
}
function receipt(plan,request,value){
 need(request.version===2&&request.command==='commission','CONTROL_RECOVERY_INTENT');
 if(value.outcome==='REFUSED'){need(exact(value.result,['error'])&&typeof value.result.error==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(value.result.error),'RESTORE_COMMISSION_RECEIPT');return;}
 const r=value.result,p=plan.controlRecovery.classes['lifecycle-operator'].principal;
 need(exact(r,['state','operatorPrincipal','authority','before','after'])&&r.state==='synthetic-restore-authority-commissioned'&&equal(r.operatorPrincipal,p),'RESTORE_COMMISSION_RECEIPT');
 require('./restore-commissioner-authority').proof(r.authority,{namespace:plan.restoreCommissioner.namespace,registryNamespace:plan.restoreCommissioner.registryNamespace},plan.controlRecovery.classes['restore-commissioner'].principal);
 for(const [key,after]of [['before',false],['after',true]]){
  need(Array.isArray(r[key])&&r[key].length===plan.lifecycleOperator.tenants.length&&r[key].every((row,i)=>exact(row,['tenant','roleOid','present','active'])&&row.tenant===plan.lifecycleOperator.tenants[i]&&row.roleOid===p.roleOid&&typeof row.present==='boolean'&&(after?row.present&&row.active===true:row.present?row.active===true:row.active===null)),'RESTORE_COMMISSION_RECEIPT');
 }
}
module.exports={config,run,receipt};
