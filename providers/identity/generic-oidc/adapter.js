'use strict';
// Registered built-in contract only. Configuration never supplies a module path.
const fs=require('node:fs'),path=require('node:path');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())fail('IDP_PROFILE_FIELDS');}
function origin(value){let url;try{url=new URL(value);}catch{fail('IDP_HTTPS_ORIGIN');}if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.hash||url.search)fail('IDP_HTTPS_ORIGIN');return url;}
function privateBytes(file,max=65536){if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(path.dirname(file))!==path.dirname(file))fail('IDP_PRIVATE_PATH');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>max)fail('IDP_PRIVATE_FILE');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(st.ino!==stat.ino||st.dev!==stat.dev||!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077))fail('IDP_PRIVATE_CHANGED');const data=Buffer.alloc(max+1);let n=0,k;while(n<data.length&&(k=fs.readSync(fd,data,n,data.length-n,null)))n+=k;if(n>max)fail('IDP_PRIVATE_BOUND');return data.subarray(0,n);}finally{fs.closeSync(fd);}}
function validate(input){
 exact(input,['version','provider','mode','issuer','clientId','secretFile','cookieKeyFile','origins','signingAlgorithm']);
 if(input.version!==1||input.provider!=='generic-oidc'||!['registry','single'].includes(input.mode))fail('IDP_REGISTERED_PROVIDER_REQUIRED');
 let issuer;try{issuer=new URL(input.issuer);}catch{fail('IDP_ISSUER');}if(typeof input.issuer!=='string'||input.issuer.length>2048||issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash)fail('IDP_ISSUER');
 if(!['RS256','PS256','ES256','EdDSA'].includes(input.signingAlgorithm))fail('IDP_SIGNING_ALGORITHM');
 if(typeof input.clientId!=='string'||!input.clientId.length||input.clientId.length>512)fail('IDP_CLIENT_ID');
 if(!Array.isArray(input.origins)||input.origins.length<1||input.origins.length>256||new Set(input.origins).size!==input.origins.length||input.mode==='single'&&input.origins.length!==1)fail('IDP_ORIGINS');input.origins.forEach(origin);
 for(const field of ['secretFile','cookieKeyFile'])if(typeof input[field]!=='string'||!path.isAbsolute(input[field]))fail('IDP_PRIVATE_PATH');
 return structuredClone(input);
}
function callbacks(input){return validate(input).origins.map(value=>value+'/api/v2/oidc/callback').sort();}
function environment(input){const value=validate(input),secret=privateBytes(value.secretFile,4096).toString().trim(),key=privateBytes(value.cookieKeyFile,128).toString().trim();if(secret.length<1||secret.length>4096||Buffer.from(key,'base64').length!==32||Buffer.from(key,'base64').toString('base64')!==key)fail('IDP_CREDENTIAL_SHAPE');return{ENABLE:'oidc',OIDC_ISSUER:value.issuer,OIDC_CLIENT_ID:value.clientId,OIDC_CLIENT_SECRET:secret,OIDC_COOKIE_KEY:key,OIDC_SIGNING_ALGORITHM:value.signingAlgorithm,...(value.mode==='single'?{OIDC_ORIGIN:value.origins[0]}:{})};}
function discovery(input,metadata){const value=validate(input);if(!metadata||metadata.issuer!==value.issuer||!metadata.code_challenge_methods_supported?.includes('S256')||!metadata.id_token_signing_alg_values_supported?.includes(value.signingAlgorithm))fail('IDP_DISCOVERY_REFUSED');for(const key of ['authorization_endpoint','token_endpoint','jwks_uri',...(metadata.end_session_endpoint?['end_session_endpoint']:[])]){let url;try{url=new URL(metadata[key]);}catch{fail('IDP_DISCOVERY_REFUSED');}if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('IDP_DISCOVERY_REFUSED');}return{issuer:value.issuer,algorithm:value.signingAlgorithm,pkce:'S256',providerLogout:!!metadata.end_session_endpoint,backchannelAdvertised:metadata.backchannel_logout_supported===true};}
module.exports={validate,origin,callbacks,environment,discovery,privateBytes,exact,fail};
