#!/usr/bin/env python3
"""Offline frozen image/Compose capture. Docker starts only an inert, network-disabled constructor.
--capture writes public, credential-free facts. Default compares with retained source-contract.
"""
import argparse, hashlib, json, pathlib, re, subprocess
import yaml
p=argparse.ArgumentParser();p.add_argument('--compose',required=True);p.add_argument('--image',required=True);p.add_argument('--diagnostic',type=pathlib.Path);p.add_argument('--capture',action='store_true');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];compose=pathlib.Path(a.compose).resolve()
files=['compose.yaml','config.js','registry-plan.js','registry-bootstrap.js','pgstream.js','bootstrap.js','entrypoint.js','service-environment.js','prime.js','Dockerfile.postgres','Dockerfile','nginx.conf','platform-startup.js','platform-verify.js','native-lifecycle.js','pgstream-source.json','pgstream-exact-handover.patch','health.js','load-env.js','realtime-workers.js','evaluator-workers.js']
node="""
const fs=require('node:fs'),crypto=require('node:crypto');
const p=require('/opt/app/deploy/multitenant/config'),l=p.layout();
const urls=Object.fromEntries(Object.keys(l.roles).map(k=>[k,'identity:'+k]));
const d=p.documents({layout:l,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200'});
const identities=Object.fromEntries([...Object.entries(d.environments),['admin',d.admin.environment],['ui',d.uiEnvironment]].map(([k,v])=>[k,[...new Set(Object.values(v).filter(x=>typeof x==='string'&&x.startsWith('identity:')).map(x=>x.slice(9)))].sort()]));identities.pgstream=['pgstream'];
const native=require('/opt/app/lib/tenant-lifecycle/native-selection');
const selected=require('/opt/app/deploy/multitenant/native-lifecycle').select(l,d,{system_id:'123',timeline:1,database:'nightscout_compose_test',slot:l.prefix+'_pgstream'});
const nativeCatalogueSha256=crypto.createHash('sha256').update(JSON.stringify(native.catalogue(selected))).digest('hex');
const files=JSON.parse(process.argv[1]);
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync('/usr/local/bin/pgstream')).digest('hex');
console.log(JSON.stringify({platformVerificationVersion:require('/opt/app/lib/server/serve/platform-verification').VERSION,producerBinarySha256:binarySha256,nativeCatalogueSha256,receipt:require('/opt/app/deploy/multitenant/.image-source.json'),postgresIdentities:identities,files:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync('/opt/app/deploy/multitenant/'+f)).digest('hex')]))}));
"""
# Dockerfiles are build inputs, not installed in the immutable runtime image.
imageFiles=[f for f in files if not f.startswith('Dockerfile') and f not in ('compose.yaml','pgstream-exact-handover.patch','pgstream-source.json')]
result=json.loads(subprocess.check_output(['docker','run','--rm','--network','none','--read-only','--entrypoint','node',a.image,'-e',node,json.dumps(imageFiles)],text=True))
hashes={f:hashlib.sha256((compose/'multitenant'/f).read_bytes()).hexdigest() for f in files}
# Record what the image carries; a later binding-only Compose commit is not a refusal.
hashes.update(result['files'])
services=yaml.safe_load((compose/'multitenant/compose.yaml').read_text())['services']
def default(s):
    return re.sub(r'\$\{[A-Z_]+:-([^}]+)\}',r'\1',s)
commands={k:[default(x) for x in v['command']] for k,v in services.items() if 'command' in v}
imageId=subprocess.check_output(['docker','image','inspect',a.image,'--format','{{.Id}}'],text=True).strip()
contract={'schemaVersion':1,'coreCommit':result['receipt']['coreCommit'],'deployCommit':result['receipt']['deployCommit'],'localImageId':imageId,'published':False,'producerBinarySha256':result['producerBinarySha256'],'commands':commands,'postgresIdentities':result['postgresIdentities'],'sourceFilesSha256':hashes,'scope':'Offline constructor and byte equivalence; cluster and capacity UNMEASURED'}
startup_versions={'platform-verification-v2':'startup-v2','platform-verification-v3':'startup-v3','platform-verification-v4':'startup-v4'}
if result['platformVerificationVersion'] not in startup_versions:raise SystemExit('FAIL platform proof contract is unsupported')
contract.update(bindingInputsVersion=1,nativeCatalogueSha256=result['nativeCatalogueSha256'],platformVerification=startup_versions[result['platformVerificationVersion']],platformVerificationVersion=result['platformVerificationVersion'])
if a.diagnostic:
    payload=a.diagnostic.read_bytes()
    diagnostic=json.loads(payload)
    receipt_bytes=pathlib.Path(diagnostic['imageReceipt']).read_bytes()
    receipt=json.loads(receipt_bytes)
    if (diagnostic.get('status'),diagnostic.get('sourceAcceptance'))!=('FROZEN_DIAGNOSTIC_ONLY','PENDING') or (
        diagnostic['coreCommit'],diagnostic['deployCommit'],diagnostic['imageId'])!=(contract['coreCommit'],contract['deployCommit'],imageId) or (
        hashlib.sha256(receipt_bytes).hexdigest()!=diagnostic['imageReceiptSha256']) or (
        receipt['coreCommit'],receipt['deployCommit'],receipt['localImageId'],receipt['runtime']['binarySha256'])!=(
            contract['coreCommit'],contract['deployCommit'],imageId,contract['producerBinarySha256']):
        raise SystemExit('FAIL diagnostic-image-source-equivalence')
    contract.update(diagnosticSha256=hashlib.sha256(payload).hexdigest(),imageReceiptSha256=diagnostic['imageReceiptSha256'],
                    nativeCatalogueSha256=result['nativeCatalogueSha256'],sourceAcceptance='PENDING')
file=root/'assets/source-contract.json'
if a.capture:file.write_text(json.dumps(contract,indent=2,sort_keys=True)+'\n')
elif json.loads(file.read_text())!=contract:raise SystemExit('FAIL source-byte-equivalence: retained source contract differs')
print('ok   source-byte-equivalence: frozen image receipt, role identities, commands and installed source bytes')
