'use strict';
// The stdin pipe is owned by the controller. EOF also fences a hook after SIGKILL.
const {spawn}=require('node:child_process');
const [rawTimeout,exe,...args]=process.argv.slice(2);
const child=spawn(exe,args,{detached:true,stdio:['ignore','inherit','inherit'],env:process.env});
let stopping=false,hardKill;
function stop() {
  if(stopping)return;stopping=true;
  try{process.kill(-child.pid,'SIGTERM');}catch{/* already exited */}
  hardKill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{/* already exited */}},200);
}
const deadline=setTimeout(stop,Number(rawTimeout));
process.stdin.resume();process.stdin.once('end',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
child.once('error',e=>{clearTimeout(deadline);process.stderr.write('Supervised child could not start: '+e.code+'\n');process.exit(127);});
child.once('close',code=>{
  clearTimeout(deadline);clearTimeout(hardKill);process.exit(stopping?124:(code ?? 1));
});
