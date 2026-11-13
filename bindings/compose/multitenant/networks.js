'use strict';
// Explicit preparation only; this validates address syntax, not host availability.
const fail=()=>Object.assign(new Error('COMPOSE_NETWORK_INVALID'),{code:'COMPOSE_NETWORK_INVALID'});
function range(cidr){
 if(typeof cidr!=='string'||!/^((?:0|[1-9][0-9]{0,2})\.){3}(?:0|[1-9][0-9]{0,2})\/(?:[89]|[12][0-9]|30)$/.test(cidr))throw fail();
 const [ip,raw]=cidr.split('/'),bytes=ip.split('.').map(Number),prefix=Number(raw);if(bytes.some(x=>x>255))throw fail();
 const first=bytes.reduce((a,b)=>a*256+b,0),size=2**(32-prefix),last=first+size-1;
 if(first%size!==0||![[167772160,184549375],[2886729728,2887778303],[3232235520,3232301055]].some(([a,b])=>first>=a&&last<=b))throw fail();
 return{cidr,first,last,addresses:size};
}
function select(backend,edge){if(backend===undefined&&edge===undefined)return null;if(backend===undefined||edge===undefined)throw fail();const b=range(backend),e=range(edge);if(b.first<=e.last&&e.first<=b.last)throw fail();return{backend:b,edge:e};}
function render(selected){if(!selected)return '';return '\nnetworks:\n'+['backend','edge'].map(key=>'  '+key+':\n    ipam:\n      config:\n        - subnet: '+selected[key].cidr+'\n').join('');}
module.exports={range,select,render};
