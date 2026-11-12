'use strict';
// Metadata observer only: never authorizes, emits, schedules or changes predicates.
const typedCode=require('../replacement-observation').code;
const knownMessages=new Set(['websocket error','xhr poll error','timeout','transport close','io server disconnect','io client disconnect','ping timeout']);
function error(value){const out={};if(typeof value?.code==='string')out.code=typedCode(value.code);if(knownMessages.has(value?.message))out.message=value.message;return out;}
function ack(value){const out={};for(const key of ['success','read','write','authorized'])if(typeof value?.[key]==='boolean')out[key]=value[key];return out;}
function attach({socket,label,namespace,effectIdentity,discriminate=()=>null,now=()=>performance.now()}){
 const start=now(),data={label,namespace,connections:0,frames:0,alarmsTotal:0,acksTotal:0,eventsTotal:0,acks:[],alarms:[],events:[]};
 function event(kind,meta={}){data.eventsTotal++;data.events.push({kind,atMs:Math.max(0,Math.ceil(now()-start)),...meta});if(data.events.length>64)data.events.shift();}
 socket.on('connect',()=>{data.connections++;event('connect');});socket.on('connect_error',e=>event('connect-error',error(e)));socket.on('error',e=>event('error',error(e)));socket.on('disconnect',reason=>event('disconnect',error({message:reason})));socket.io.on('reconnect_attempt',()=>event('reconnect-attempt'));socket.io.on('reconnect_error',e=>event('reconnect-error',error(e)));socket.on('dataUpdate',()=>{data.frames++;if(data.frames===1)event('initial-frame');});
 for(const type of ['alarm','urgent_alarm','clear_alarm'])socket.on(type,payload=>{let digest=null;try{digest=effectIdentity(payload);}catch{}const syntheticTitleMatch=payload?.title==='Synthetic shipping alarm-a'?'alarm-a':payload?.title==='Synthetic shipping alarm-b'?'alarm-b':payload?.title==='Synthetic cold target'?'cold-target':null;let probeDiscriminator=null;try{probeDiscriminator=discriminate(payload);}catch{}data.alarmsTotal++;data.alarms.push({event:type,atMs:Math.max(0,Math.ceil(now()-start)),clear:payload?.clear===true,sourceEffectDigest:/^[0-9a-f]{64}$/.test(digest||'')?digest:null,syntheticTitleMatch,probeDiscriminator});if(data.alarms.length>64)data.alarms.shift();});
 return{ack(kind,value){data.acksTotal++;const meta={operation:kind,...ack(value)};data.acks.push(meta);if(data.acks.length>64)data.acks.shift();event('ack',meta);},snapshot(){return JSON.parse(JSON.stringify({...data,acksTruncated:data.acksTotal>64,alarmsTruncated:data.alarmsTotal>64,eventsTruncated:data.eventsTotal>64}));}};
}
module.exports={attach};
