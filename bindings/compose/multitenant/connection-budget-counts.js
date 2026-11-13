'use strict';
// Native synthetic oracle only. Caller data selects no SQL identifiers or role.
const crypto=require('node:crypto');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const FIELDS=['tenant','entriesTotal','entries','devicestatus','treatments','probe'];
function selector(value){
 need(exact(value,['version','kind','runId','tenants'])&&value.version===1&&value.kind==='native-synthetic-stored-counts','CONNECTION_COUNTS_SELECTOR');
 need(typeof value.runId==='string'&&/^m7-native-[a-f0-9]{16,32}$/.test(value.runId),'CONNECTION_COUNTS_RUN_ID');
 need(Array.isArray(value.tenants)&&value.tenants.length>=1&&value.tenants.length<=128
   &&value.tenants.every(t=>typeof t==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(t))
   &&new Set(value.tenants).size===value.tenants.length,'CONNECTION_COUNTS_TENANTS');
 return {version:1,kind:value.kind,runId:value.runId,tenants:[...value.tenants]};
}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(selector(value))).digest('hex');}
function expression(value){
 const s=selector(value),ids=s.tenants.map(t=>"'"+t+"'::uuid").join(','),run="'"+s.runId+"'",probe="'"+s.runId+"-probe'";
 // layout() is the fixed shipped nsdemo plan; all three catalogues expose
 // tenant_id uuid and doc jsonb. No payload or document identity is returned.
 const perTenant="(SELECT json_agg(json_build_object('tenant',t.tenant::text,"+
 "'entriesTotal',(SELECT count(*) FROM nsdemo_entries.entries e WHERE e.tenant_id=t.tenant),"+
 "'entries',(SELECT count(*) FROM nsdemo_entries.entries e WHERE e.tenant_id=t.tenant AND e.doc->>'device'="+run+"),"+
 "'devicestatus',(SELECT count(*) FROM nsdemo_devicestatus.devicestatus d WHERE d.tenant_id=t.tenant AND d.doc->>'device'="+run+"),"+
 "'treatments',(SELECT count(*) FROM nsdemo_treatments.treatments x WHERE x.tenant_id=t.tenant AND x.doc->>'enteredBy'="+run+"),"+
 "'probe',(SELECT count(*) FROM nsdemo_entries.entries e WHERE e.tenant_id=t.tenant AND e.doc->>'device'="+probe+")) ORDER BY t.ordinal)"+
 " FROM unnest(ARRAY["+ids+"]) WITH ORDINALITY AS t(tenant,ordinal))";
 const foreign="json_build_object('entries',(SELECT count(*) FROM nsdemo_entries.entries e WHERE NOT(e.tenant_id=ANY(ARRAY["+ids+"])) AND e.doc->>'device'="+run+"),"+
 "'devicestatus',(SELECT count(*) FROM nsdemo_devicestatus.devicestatus d WHERE NOT(d.tenant_id=ANY(ARRAY["+ids+"])) AND d.doc->>'device'="+run+"),"+
 "'treatments',(SELECT count(*) FROM nsdemo_treatments.treatments x WHERE NOT(x.tenant_id=ANY(ARRAY["+ids+"])) AND x.doc->>'enteredBy'="+run+"),"+
 "'probe',(SELECT count(*) FROM nsdemo_entries.entries e WHERE NOT(e.tenant_id=ANY(ARRAY["+ids+"])) AND e.doc->>'device'="+probe+"))";
 return "json_build_object('rows',"+perTenant+",'foreign',"+foreign+")";
}
function rows(value,result){
 const s=selector(value);
 need(Array.isArray(result)&&result.length===s.tenants.length,'CONNECTION_COUNTS_RESULT');
 for(let i=0;i<result.length;i++){
  const row=result[i];need(exact(row,FIELDS)&&row.tenant===s.tenants[i],'CONNECTION_COUNTS_RESULT');
  need(FIELDS.slice(1).every(k=>Number.isSafeInteger(row[k])&&row[k]>=0),'CONNECTION_COUNTS_RESULT');
  need(row.entries<=row.entriesTotal&&row.probe<=row.entriesTotal-row.entries,'CONNECTION_COUNTS_OVERCOUNT');
 }
 return result.map(row=>({...row}));
}
function result(value,payload){
 need(exact(payload,['rows','foreign']),'CONNECTION_COUNTS_RESULT');
 const counts=rows(value,payload.rows),fields=['entries','devicestatus','treatments','probe'];
 need(exact(payload.foreign,fields)&&fields.every(k=>Number.isSafeInteger(payload.foreign[k])&&payload.foreign[k]>=0),'CONNECTION_COUNTS_FOREIGN_RESULT');
 // Positive foreign observations remain visible. The episode, not this reader,
 // decides whether the observed counts satisfy its expected synthetic writes.
 return {rows:counts,foreign:{...payload.foreign}};
}
function diagnostic(value,payload){
 const s=selector(value),foreign={};
 for(const key of ['entries','devicestatus','treatments','probe']){const v=payload?.foreign?.[key];foreign[key]=Number.isSafeInteger(v)&&v>=0?v:null;}
 return {version:1,kind:'unvalidated-native-stored-counts-observation',selector:s,selectorSha256:hash(s),foreign,
   validation:'UNVALIDATED_DIAGNOSTIC_NOT_ACCEPTANCE'};
}
module.exports={selector,hash,expression,rows,result,diagnostic};
