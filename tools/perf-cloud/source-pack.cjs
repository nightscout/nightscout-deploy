'use strict';
// Original commit/tree identity, selected tracked blobs only. No working-tree content.
const {createWriteStream}=require('node:fs');
const {spawn}=require('node:child_process');
const {command}=require('./drivers');
const PATHS=['tools/mt-bench/m7-joined','tools/mt-bench/capacity','tools/mt-bench/compose-baseline'];
async function sparsePack(repo,commit,file,paths=PATHS){
  if(!/^[a-f0-9]{40}$/.test(commit)||!paths.length||paths.some(p=>!/^tools\/[a-zA-Z0-9_./-]+$/.test(p)||p.split('/').includes('..')))throw new Error('SPARSE_SOURCE_SCOPE_INVALID');
  await command('git',['-C',repo,'cat-file','-e',commit+'^{commit}']);
  const root=(await command('git',['-C',repo,'rev-parse',commit+'^{tree}'])).stdout.trim();
  const rows=(await command('git',['-C',repo,'ls-tree','-rtz','--full-tree',commit])).stdout.split('\0').filter(Boolean);
  const objects=new Set([commit,root]),selected=[];
  for(const row of rows){
    const match=row.match(/^\d+ (tree|blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/);if(!match)throw new Error('SPARSE_SOURCE_TREE_INVALID');
    const [,type,oid,name]=match;
    if(type==='tree')objects.add(oid);
    if(type==='blob'&&paths.some(p=>name===p||name.startsWith(p+'/'))){objects.add(oid);selected.push(name);}
  }
  if(paths.some(p=>!selected.some(n=>n===p||n.startsWith(p+'/'))))throw new Error('SPARSE_SOURCE_PATH_MISSING');
  await new Promise((resolve,reject)=>{
    const output=createWriteStream(file,{mode:0o600});let written=false,exited=false;
    const done=()=>{if(written&&exited)resolve();};output.on('finish',()=>{written=true;done();});output.on('error',reject);
    const process=spawn('nice',['-n','19','git','-C',repo,'pack-objects','--compression=0','--threads=1','--stdout'],{stdio:['pipe','pipe','pipe']});
    let stderr='';process.stderr.on('data',v=>stderr+=v);process.on('error',reject);process.stdout.pipe(output);process.stdin.end([...objects].join('\n')+'\n');
    process.on('close',code=>{if(code!==0)reject(new Error('SPARSE_SOURCE_EXPORT_FAILED'));else{exited=true;done();}});
  });
  return {commit,paths,files:selected.length,objects:objects.size};
}
module.exports={sparsePack,PATHS};
