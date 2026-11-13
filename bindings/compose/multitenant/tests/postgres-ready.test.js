'use strict';
// Actual POSIX helper under owned synthetic /proc/data fixtures: no server,
// network, database, Docker, role credentials or PostgreSQL process is started.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const original=fs.readFileSync(path.join(__dirname,'../postgres-ready.sh'),'utf8');
function fixture(transform=s=>s){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pg-marker-')),data=path.join(root,'data'),proc=path.join(root,'proc'),bin=path.join(root,'bin');for(const dir of [data,path.join(proc,'1'),bin])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(data,'postmaster.pid'),fields=['1','(postgres)','S',...Array(18).fill('0'),'100'];
 fs.writeFileSync(path.join(proc,'1/stat'),fields.join(' ')+'\n');fs.writeFileSync(path.join(proc,'stat'),'btime 100\n');
 fs.writeFileSync(file,['1',data,'101','5432','/var/run/postgresql','*','123 456','ready   '].join('\n')+'\n');fs.writeFileSync(path.join(bin,'postgres'),'#!/bin/sh\nexit 99\n',{mode:0o700});fs.symlinkSync(path.join(bin,'postgres'),path.join(proc,'1/exe'));
 const script=path.join(root,'ready.sh');fs.writeFileSync(script,transform(original).replaceAll('/var/lib/postgresql/data',data).replaceAll('/proc/',proc+'/'));
 const env={...process.env,PG_MAJOR:'16',PG_VERSION:'16.15',PG_SHA256:'c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed',PGDATA:data,PATH:bin+':'+process.env.PATH};
 return{root,data,proc,bin,file,env,edit(from,to){fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(from,to));},run(){const r=spawnSync('/bin/sh',[script],{env,encoding:'utf8',timeout:2000,maxBuffer:4096});assert(!r.error,r.error?.message);return r.status;},close(){fs.rmSync(root,{recursive:true});}};
}
const cases=[['starting',f=>f.edit('ready   ','starting')],['stopping',f=>f.edit('ready   ','stopping')],['standby',f=>f.edit('ready   ','standby ')],['stale-start',f=>f.edit('\n101\n','\n100\n')],['wrong-pid',f=>f.edit('1\n','22\n')],['temporary-init',f=>f.edit('1\n','77\n')],['entrypoint-shell',f=>{fs.unlinkSync(path.join(f.proc,'1/exe'));fs.symlinkSync('/bin/sh',path.join(f.proc,'1/exe'));}],['paused',f=>fs.writeFileSync(path.join(f.proc,'1/stat'),'1 (postgres) T '+Array(18).fill('0').join(' ')+' 100\n')],['zombie',f=>fs.writeFileSync(path.join(f.proc,'1/stat'),'1 (postgres) Z '+Array(18).fill('0').join(' ')+' 100\n')],['hot-standby',f=>fs.writeFileSync(path.join(f.data,'standby.signal'),'')],['changed-during-read',f=>{fs.writeFileSync(path.join(f.bin,'cat'),'#!/bin/sh\nif [ -f '+JSON.stringify(path.join(f.root,'cat-used'))+' ]; then /bin/cat "$@"; printf changed; else : > '+JSON.stringify(path.join(f.root,'cat-used'))+'; /bin/cat "$@"; fi\n',{mode:0o700});}],['partial',f=>fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').slice(0,-4))],['wrong-data-dir',f=>f.edit(f.data,'/different')],['no-tcp-listener',f=>f.edit('\n*\n','\n\n')],['future-start',f=>f.edit('\n101\n','\n'+(Math.floor(Date.now()/1000)+1000)+'\n')],['wrong-source',f=>f.env.PG_SHA256='unknown'],['oversize',f=>fs.appendFileSync(f.file,'x'.repeat(4096))],['symlink-pidfile',f=>{const outside=path.join(f.root,'outside');fs.renameSync(f.file,outside);fs.symlinkSync(outside,f.file);}]];
test('POSIX marker accepts its exact ready primary and rejects all source/state/identity negatives',()=>{const f=fixture();try{assert.equal(f.run(),0);}finally{f.close();}for(const[name,change]of cases){const f=fixture();try{change(f);assert.notEqual(f.run(),0,name);}finally{f.close();}}});
test('meaningful status/start-time/stability controls produce false ready only when the corresponding guard is removed',()=>{
 for(const[name,change,needle,replacement]of [['status',cases[0][1],"[ \"$status\" = 'ready   ' ]",':'],['start-time',cases[3][1],'[ "$started" -ge "$((boot + ticks / hz))" ]',':'],['stability',cases[10][1],'[ "$(cat "$f")" = "$first" ]',':']]){
 const f=fixture(s=>{assert.equal(s.split(needle).length,2);return s.replace(needle,replacement);});try{change(f);assert.equal(f.run(),0,name+' mutant demonstrates a false ready result');}finally{f.close();}
 const restored=fixture();try{change(restored);assert.notEqual(restored.run(),0,name+' restored rejects');}finally{restored.close();}
 }
});
