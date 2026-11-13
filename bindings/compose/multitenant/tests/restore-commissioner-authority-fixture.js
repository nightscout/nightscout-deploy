'use strict';
// Recording metadata only, never a role/grant/native proof.
const Authority=require('../restore-commissioner-authority');
function raw(config,principal){
 const allowed=Authority.expected(config);
 return {role:{oid:principal.roleOid,rolsuper:false,rolbypassrls:true,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false},memberships:0,ownerships:0,schemas:[{namespace:config.namespace,usage:true,create:false},{namespace:config.registryNamespace,usage:true,create:false},{namespace:'public',usage:true,create:false}],relations:allowed.map(a=>({namespace:a.namespace,relation:a.relation,...Object.fromEntries(Authority.PRIV.map(k=>[k,k==='select'||k==='columnSelect'?true:k==='insert'||k==='columnInsert'?a.insert:false]))})),applicationFunctions:0,sequences:0,explicitCrossDatabase:0,defaultApplicationGrants:0,permanentDatabaseDdl:false,observer:false,baseline:{temporaryDatabasePrivilege:true,publicSchemaUsage:true,catalogMetadata:'BASELINE_NOT_APPLICATION_AUTHORITY'}};
}
module.exports={raw};
