'use strict';
// Recording metadata only, never a role/grant/native proof.
const Authority=require('../restore-commissioner-authority');
function raw(config,principal){
 const allowed=Authority.expected(config);
 return {role:{oid:principal.roleOid,rolsuper:false,rolbypassrls:true,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false},memberships:0,ownerships:0,schemas:[{namespace:config.namespace,usage:true,create:false},{namespace:config.registryNamespace,usage:true,create:false},{namespace:'public',usage:true,create:false}],relations:allowed.map(a=>({namespace:a.namespace,relation:a.relation,...Object.fromEntries(Authority.PRIV.map(k=>[k,k==='select'||k==='columnSelect'?true:k==='insert'||k==='columnInsert'?a.insert:false]))})),applicationFunctions:0,sequences:0,explicitCrossDatabase:0,defaultApplicationGrants:0,permanentDatabaseDdl:false,observer:false,baseline:{temporaryDatabasePrivilege:true,publicSchemaUsage:true,catalogMetadata:'BASELINE_NOT_APPLICATION_AUTHORITY'}};
}
function recorded(sql,config,principal){
 const value=raw(config,principal);
 // PostgreSQL folds unquoted result aliases. Keep recording metadata tied to
 // the actual SQL projection instead of silently returning desired JS keys.
 return Object.fromEntries(Object.entries(value).map(([key,v])=>{const pattern=new RegExp('\\bAS\\s+("'+key+'"|'+key+')(?=\\s*(?:,|$))','i'),match=sql.match(pattern);if(!match)throw Error('UNMODELLED_AUTHORITY_PROJECTION '+key);return [match[1].startsWith('"')?match[1].slice(1,-1):match[1].toLowerCase(),v];}));
}
module.exports={raw,recorded};
