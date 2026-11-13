'use strict';
// Fresh host-plan custody only. URL validation constructs the installed driver's
// pure ConnectionParameters, never a Client/Pool/login. It is not backend proof.
const {isDeepStrictEqual:equal}=require('node:util');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function identity(value){need(value&&typeof value==='object'&&!Array.isArray(value)&&equal(Object.keys(value).sort(),['database','databaseOid'])&&typeof value.database==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(value.database)&&typeof value.databaseOid==='string'&&/^[1-9][0-9]{0,9}$/.test(value.databaseOid)&&Number(value.databaseOid)<=4294967295,'WORKER_DATABASE_IDENTITY');return structuredClone(value);}
function effective(value){need(typeof value==='string'&&/^postgres(?:ql)?:\/\//.test(value),'WORKER_DATABASE_URL');try{return new (require('pg/lib/connection-parameters'))({connectionString:value}).database;}catch{throw Object.assign(Error('WORKER_DATABASE_URL'),{code:'WORKER_DATABASE_URL'});}}
function seal(observed,docs){const fixed=identity(observed);for(const row of require('./connection-budget').expanded(docs)){
 const urls=Object.entries(row.env).filter(([key,value])=>/_PG$/.test(key)||typeof value==='string'&&/^postgres(?:ql)?:/.test(value));
 need(urls.length>0,'WORKER_DATABASE_URLS_MISSING');for(const [,url] of urls)need(effective(url)===fixed.database,'WORKER_DATABASE_CHANGED');
 }return fixed;}
function actual(expected,row){const fixed=identity(expected);need(row&&row.database===fixed.database&&row.databaseOid===fixed.databaseOid,'WORKER_DATABASE_BACKEND_CHANGED');return fixed;}
module.exports=Object.freeze({identity,effective,seal,actual});
