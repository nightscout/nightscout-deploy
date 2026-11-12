'use strict';
// In-memory semantic mutations only. No target file, Docker or browser action.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const definitions={
 issuer:['../../generic-oidc/adapter.js','metadata.issuer!==value.issuer','false'],
 'private-plane':['../profile.js','location ^~ /api/v1/operator {return 404;}',''],
 'ca-custody':['../profile.js',"state+'/tls/server.crt:/run/tls/server.crt:ro',state+'/tls/server.key:/run/tls/server.key:ro'","state+'/tls:/run/tls:ro'"],
 replicas:['../profile.js',"[...v.apiServices,'tenant-admin'].map","[v.apiServices[0],'tenant-admin'].map"],
 'file-mode':['../../generic-oidc/adapter.js','(stat.mode&0o077)','false'],
 'provider-network':['../profile.js',"networks:['provider']","networks:['provider','application']"]
};
const spec=definitions[process.argv[2]];if(!spec)throw new Error('KNOWN_IDP_CONTROL_REQUIRED');
const file=require.resolve(path.join(__dirname,spec[0])),source=fs.readFileSync(file,'utf8');if(!source.includes(spec[1]))throw new Error('IDP_CONTROL_SOURCE_CHANGED');
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));let mutated=source.replace(spec[1],spec[2]);if(process.argv[2]==='file-mode'){if(!mutated.includes('(st.mode&0o077)'))throw Error('IDP_CONTROL_SOURCE_CHANGED');mutated=mutated.replace('(st.mode&0o077)','false');}m._compile(mutated,file);require.cache[file]=m;
require('./profile.test');
