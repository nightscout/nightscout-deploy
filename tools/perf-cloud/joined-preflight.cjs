#!/usr/bin/env node
'use strict';
// Offline only. This does not provision, build, deploy or execute the instrument.
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const {command}=require('./drivers');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const requireValue=(condition,code)=>{if(!condition)throw new Error(code);};
function acceptance(receipt,bytes,pair){
  requireValue(receipt?.kind==='joined-acceptance'&&receipt.status==='PASS','JOINED_ACCEPTANCE_NOT_PASS');
  requireValue(receipt.pair?.core===pair.core&&receipt.pair?.deploy===pair.deploy&&Object.keys(receipt.pair).length===2,'JOINED_ACCEPTANCE_PAIR_MISMATCH');
  requireValue(/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)&&sha(bytes)===receipt.evidenceSha256,'JOINED_ACCEPTANCE_EVIDENCE_MISMATCH');
}
function counts(text,name='COUNTS'){
  // Refuse a changed contract shape; never guess a count or execute provisional Python.
  requireValue(['COUNTS','PILOT_COUNTS'].includes(name),'JOINED_COUNT_CONTRACT_UNSUPPORTED');
  const match=text.match(new RegExp('^'+name+'\\s*=\\s*\\(([0-9,\\s]+)\\)\\s*$','m'));
  requireValue(match,'JOINED_COUNT_CONTRACT_UNSUPPORTED');
  const values=match[1].split(',').map(x=>x.trim()).filter(Boolean).map(Number);
  requireValue(values.length>0&&values.every((n,i)=>Number.isSafeInteger(n)&&n>0&&(i===0||n>values[i-1])),'JOINED_COUNT_CONTRACT_INVALID');
  return values;
}
async function inspect(options){
  const profile=options.profile||'remote-pilot';
  requireValue(['remote-pilot','capacity'].includes(profile),'JOINED_INSPECTION_PROFILE_INVALID');
  const sources={};
  for(const name of ['core','deploy','alignment']){
    const pin=options[name+'Commit'];requireValue(/^[a-f0-9]{40}$/.test(pin),'JOINED_FULL_SOURCE_PIN_REQUIRED');
    const result=await command('git',['-C',options[name],'rev-parse','--verify',pin+'^{commit}']);
    requireValue(result.stdout.trim()===pin,'JOINED_SOURCE_UNAVAILABLE');sources[name]=pin;
  }
  const show=async file=>(await command('git',['-C',options.alignment,'show',sources.alignment+':'+file])).stdout;
  const paths=['adapter.py','contract.py','probe.py','workload.py','workload-shapes.cjs','reduce.py'].map(x=>'tools/mt-bench/m7-joined/'+x);
  paths.push('tools/mt-bench/capacity/probe.js','tools/mt-bench/capacity/k6/workload.js','tools/mt-bench/compose-baseline/probes/sample.sh','tools/mt-bench/compose-baseline/oracle/disk.sh');
  const files={};let supported;
  for(const file of paths){const text=await show(file);files[file]=sha(text);if(file.endsWith('/contract.py'))supported=counts(text,profile==='remote-pilot'?'PILOT_COUNTS':'COUNTS');}
  const levels=options.levels||[500,750,1000];
  requireValue(Array.isArray(levels)&&levels.length>0&&levels.length<=5&&levels.every((n,i)=>Number.isSafeInteger(n)&&n>0&&(i===0||n>levels[i-1])),'JOINED_LEVELS_INVALID');
  const blockers=[];if(levels.some(n=>!supported.includes(n)))blockers.push('JOINED_CONTROL_COUNTS_NOT_SUPPORTED');
  let evidenceSha256=null;
  if(options.freeze||options.evidence){
    requireValue(options.freeze&&options.evidence,'JOINED_RECEIPT_AND_EVIDENCE_REQUIRED');
    const receipt=JSON.parse(await fs.readFile(options.freeze,'utf8')),bytes=await fs.readFile(options.evidence);
    acceptance(receipt,bytes,{core:sources.core,deploy:sources.deploy});evidenceSha256=receipt.evidenceSha256;
  }else blockers.push('JOINED_ACCEPTANCE_NOT_SUPPLIED');
  return {version:1,scope:'OFFLINE_JOINED_HANDOFF_INSPECTION',profile,sources,levels,supportedCounts:supported,files,evidenceSha256,blockers,
    sourceChecksPass:blockers.length===0,liveReady:false,
    remaining:['Remote adapter command/artifact contract must be agreed with implementation owner.','Pinned alignment must be restored as a Git checkout; an archive alone fails instrument attribution.','New seven-shape hot-tenant workload is a distinct profile from historical b4.'],
    cloudActions:0,runtimeTests:0};
}
async function main(args){
  const options={};const names={'profile':'profile','core':'core','deploy':'deploy','alignment':'alignment','core-commit':'coreCommit','deploy-commit':'deployCommit','alignment-commit':'alignmentCommit','freeze':'freeze','evidence':'evidence','levels':'levels'};
  for(let i=0;i<args.length;i+=2){const key=names[args[i]?.slice(2)];requireValue(args[i]?.startsWith('--')&&key&&args[i+1]&&!Object.hasOwn(options,key),'JOINED_OPTION_INVALID');options[key]=key==='levels'?args[i+1].split(',').map(Number):args[i+1];}
  for(const name of ['core','deploy','alignment'])requireValue(options[name]&&options[name+'Commit'],'JOINED_SOURCE_ARGUMENT_REQUIRED');
  process.stdout.write(JSON.stringify(await inspect(options),null,2)+'\n');
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{process.stderr.write('JOINED_PREFLIGHT_REFUSED: check pinned source, count contract and acceptance evidence.\n');process.exitCode=1;});
module.exports={acceptance,counts,inspect,sha};
