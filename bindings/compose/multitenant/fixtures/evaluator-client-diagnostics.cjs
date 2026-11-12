'use strict';
// Test-only metadata. Never retain credentials or print reply/frame payloads.
function ack(value){const result={};for(const key of ['success','read','write','authorized'])if(typeof value?.[key]==='boolean')result[key]=value[key];const code=typeof value?.code==='string'?value.code:typeof value?.error?.code==='string'?value.error.code:null;if(code&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code))result.code=code;if(typeof value?.message==='string'&&['Subscribed for alarms','Access denied','Unauthorized'].includes(value.message))result.message=value.message;return result;}
function error(value){const result={};if(typeof value?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code))result.code=value.code;const known=new Set(['websocket error','xhr poll error','timeout','Invalid namespace','transport close','io server disconnect','io client disconnect','ping timeout']);if(known.has(value?.message))result.message=value.message;const status=value?.context?.status||value?.description?.statusCode||value?.status;if(Number.isInteger(status)&&status>=100&&status<=599)result.status=status;return result;}
function connect({io,origin,namespace,agent,accessToken,secret,name,now=()=>performance.now()}){
 const start=now(),socket=io(origin+namespace,{forceNew:true,autoUnref:true,transports:['websocket'],agent,timeout:2000});
 const seen={socket,name,namespace,acks:[],authorizeAcks:[],frames:[],alarms:[],connections:0,events:[]};
 const event=(kind,details={})=>{if(seen.events.length<64)seen.events.push({kind,atMs:Math.ceil(now()-start),...details});};
 socket.on('connect',()=>{seen.connections++;event('connect');if(namespace==='/')socket.emit('authorize',{secret},reply=>{seen.authorizeAcks.push(ack(reply));event('authorize-ack',ack(reply));});else socket.emit('subscribe',{accessToken},reply=>{seen.acks.push(reply);event('subscribe-ack',ack(reply));});});
 socket.on('connect_error',value=>event('connect-error',error(value)));socket.on('error',value=>event('error',error(value)));socket.on('disconnect',reason=>event('disconnect',error({message:reason})));
 socket.io.on('reconnect_attempt',()=>event('reconnect-attempt'));socket.io.on('reconnect_error',value=>event('reconnect-error',error(value)));
 socket.on('dataUpdate',frame=>{seen.frames.push(frame);if(seen.frames.length===1)event('initial-frame');});for(const kind of ['alarm','urgent_alarm'])socket.on(kind,payload=>seen.alarms.push({event:kind,payload}));
 return seen;
}
function prerequisites(a,b,main){return a.acks.some(row=>row.success)&&b.acks.some(row=>row.success)&&main.frames.length>0;}
function summary(seen){return{name:seen.name,namespace:seen.namespace,connections:seen.connections,subscribed:seen.acks.some(row=>row.success),subscribeAcks:seen.acks.map(ack),authorizeAcks:seen.authorizeAcks,initialFrames:seen.frames.length,events:seen.events};}
module.exports={connect,prerequisites,summary};
