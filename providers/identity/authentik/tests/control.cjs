'use strict';
// In-memory semantic mutations only. No target file, Docker or browser action.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const definitions={
 'source-overlay':['../run.js','!fs.readFileSync(own).equals(fs.readFileSync(path.join(input.deployment,file)))','false'],
 'probe-trust':['../native-probes.cjs','TRUST_ERRORS.has(code)','Boolean(code)'],
 'probe-host':['../native-probes.cjs','denied.status===421','true'],
 'probe-password':['../native-probes.cjs',"body?.component==='ak-stage-password'",'true'],
 'probe-restored':['../native-probes.cjs','discovery(c,await send(c,url,trusted));\n return','\n return'],
 'probe-verification':['../native-probes.cjs','rejectUnauthorized:true','rejectUnauthorized:false'],
 'resource-recreation':['../run.js','files.push(appResourceFile(c));',''],
 'resource-authority':['../resources.js','!isDeepStrictEqual(stripped,before)','false'],
 'resource-budget':['../resources.js','for(const name of apis)limits[name]=limit(1,768);','for(const name of apis.slice(0,1))limits[name]=limit(1,768);'],
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
require(process.argv[2].startsWith('source-')?'./joined-source-admission.test':process.argv[2].startsWith('probe-')?'./native-probes.test':process.argv[2].startsWith('resource-')?'./resources.test':'./profile.test');
