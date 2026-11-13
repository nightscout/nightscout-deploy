'use strict';
// Fixed admitted-capture qualification, on the SAME repeatable-read backend as
// core export. Return scalar metadata/count/byte totals, never tenant row data.
// No compressed-storage estimate, extra acquisition, cursor or core override.
const {LIMIT,jsonBytes}=require('./lifecycle-capture-bound');
const need=(v,c='LIFECYCLE_ARTIFACT_BOUND')=>{if(!v)throw Object.assign(Error(c),{code:c});};
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v)&&v!=='public'&&v!=='information_schema'&&!v.startsWith('pg_');
const q=v=>'"'+v+'"';
// Closed built-in pg text-parser outputs: JSON values, strings/numbers/bools,
// Dates, Buffers and their built-in arrays. Custom/domain/geometric/interval
// parsers have no bound here and refuse before row_to_json/data export.
const TYPES=Object.freeze([16,17,18,19,20,21,23,25,26,114,700,701,1042,1043,1082,1114,1184,1700,2950,3802,1000,1001,1005,1007,1009,1014,1015,1016,1021,1022,1028,1115,1182,1185,1231,199,2951,3807]);
const metadataSQL=`SELECT /* capture-bound-columns */ count(*)::text AS columns,coalesce(sum(octet_length(a.attname::text)+octet_length(pg_catalog.format_type(a.atttypid,a.atttypmod))),0)::text AS bytes,count(*) FILTER(WHERE a.atttypid<>ALL(ARRAY[${TYPES.join(',')}]::oid[]))::text AS unsupported,count(*) FILTER(WHERE a.attname='tenant_id' AND a.atttypid=2950)::text AS tenantcolumns,current_setting('bytea_output') AS byteaoutput FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped`;
function integer(value){need(typeof value==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(value));return BigInt(value);}
function spec(value,tenant){
 need(value&&Array.isArray(value.catalogues)&&value.catalogues.length>0&&value.namespaces&&typeof value.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(value.sourceCommit));
 const catalogues=[],tables={};
 for(const c of value.catalogues){const namespace=value.namespaces[c.kind];need(name(c.kind)&&name(namespace)&&Array.isArray(c.tables)&&c.tables.length>0&&Array.isArray(c.secrets)&&Array.isArray(c.candidate?.migrations));const described=[];
  for(const table of c.tables){need(name(table));const key=c.kind+'.'+table;need(!Object.hasOwn(tables,key));tables[key]=[];described.push({table,columns:[],count:Number.MAX_SAFE_INTEGER,digest:'0'.repeat(64),...(c.secrets.includes(table)?{keyReferences:[]}:{})});}
  catalogues.push({kind:c.kind,namespace,ledger:c.candidate.migrations.map(m=>({name:m.name,checksum:m.checksum})),tables:described});
 }
 const format='nightscout-tenant-lifecycle-research-artifact';
 return {format,version:1,manifest:{format,version:1,tenant,sourceCommit:value.sourceCommit,exportedAt:Number.MAX_SAFE_INTEGER,keyNames:null,catalogues},tables,digest:'0'.repeat(64)};
}
async function run(query,value,tenant){
 // Exact source-known manifest/table/ledger overhead. Column descriptors are
 // qualified from scalar actual metadata below, not inferred from a row count.
 let total=BigInt(jsonBytes(spec(value,tenant),LIMIT-1)+1);
 const selected=[];
 for(const c of value.catalogues)for(const table of c.tables){const namespace=value.namespaces[c.kind],qualified=q(namespace)+'.'+q(table),result=await query(metadataSQL,[qualified]);need(result.rows.length===1);const r=result.rows[0];need(r&&Object.keys(r).sort().join(',')==='byteaoutput,bytes,columns,tenantcolumns,unsupported');const columns=integer(r.columns),bytes=integer(r.bytes);need(columns>0n&&r.unsupported==='0'&&r.tenantcolumns==='1'&&r.byteaoutput==='hex','LIFECYCLE_CAPTURE_TYPE_UNBOUNDED');
  // One descriptor has <128 fixed JSON bytes; string escaping costs at most
  // six bytes per source UTF-8 byte. Count every physical column, including
  // generated columns core omits: this deliberately overestimates the export.
  total+=128n*columns+6n*bytes;need(total<=BigInt(LIMIT));selected.push(qualified);
 }
 for(const table of selected){const result=await query('SELECT /* capture-bound-rows */ count(*)::text AS rows,coalesce(sum(octet_length(row_to_json(captured)::text)),0)::text AS bytes FROM '+table+' AS captured WHERE tenant_id=$1',[tenant]);need(result.rows.length===1);const r=result.rows[0];need(r&&Object.keys(r).sort().join(',')==='bytes,rows');const rows=integer(r.rows),bytes=integer(r.bytes);need((rows===0n)===(bytes===0n)&&52n*rows<=bytes);
  // Closed parser set + observed hex bytea output above: JSON serialization of a driver row is at most
  // 6x PostgreSQL row JSON (including bytea->Buffer and Date/number expansion).
  // A secret key-reference adds at most another 6x for its id, plus <3x for
  // fixed key-reference fields; tenant_id alone makes every PG row >=52 bytes.
  // 16x therefore covers row JSON + duplicate key references + array commas.
  // This is conservative qualification against the SAME 16MiB ceiling, not a
  // promise that every artifact below that ceiling can be admitted.
  total+=16n*bytes;need(total<=BigInt(LIMIT));
 }
 return {qualifiedArtifactBytes:total.toString()};
}
module.exports={TYPES,metadataSQL,run};
