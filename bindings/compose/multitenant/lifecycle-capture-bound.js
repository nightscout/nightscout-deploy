'use strict';
// Count JSON UTF-8 bytes without producing a whole-object JSON string/buffer.
// The fixed capture path uses ordinary pg JSON/scalar/Date/Buffer values only;
// accessors, custom serializers and cycles refuse before artifact publication.
const LIMIT=16*1024*1024;
const fail=()=>Object.assign(Error('LIFECYCLE_ARTIFACT_BOUND'),{code:'LIFECYCLE_ARTIFACT_BOUND'});
function jsonBytes(value,limit=LIMIT-1){
 let bytes=0;const held=new WeakSet(),frames=[{value}];
 const add=n=>{bytes+=n;if(!Number.isSafeInteger(bytes)||bytes>limit)throw fail();};
 function string(text){if(text.length>limit-bytes)throw fail();add(2);for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c===34||c===92||[8,9,10,12,13].includes(c))add(2);else if(c<32)add(6);else if(c<128)add(1);else if(c<2048)add(2);else if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){add(4);i++;}else add(6);}else if(c>=0xdc00&&c<=0xdfff)add(6);else add(3);}}
 function* keys(object){for(const key in object)if(Object.hasOwn(object,key))yield key;}
 while(frames.length){const frame=frames.pop();if(frame.iterator){const next=frame.iterator.next();if(next.done){held.delete(frame.object);continue;}if(frame.seen)add(1);frame.seen=true;frames.push(frame);const descriptor=Object.getOwnPropertyDescriptor(frame.object,next.value);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw fail();if(!frame.array){string(next.value);add(1);}frames.push({value:descriptor.value});continue;}
  const current=frame.value;if(current===null){add(4);continue;}if(typeof current==='string'){string(current);continue;}if(typeof current==='boolean'){add(current?4:5);continue;}if(typeof current==='number'){add(Number.isFinite(current)?String(Object.is(current,-0)?0:current).length:4);continue;}if(typeof current!=='object')throw fail();const serializer=Object.getOwnPropertyDescriptor(current,'toJSON');if(serializer&&(!Object.hasOwn(serializer,'value')||typeof serializer.value==='function'||current instanceof Date||Buffer.isBuffer(current)))throw fail();
  if(current instanceof Date){if(Number.isFinite(Date.prototype.getTime.call(current)))string(Date.prototype.toISOString.call(current));else add(4);continue;}
  if(Buffer.isBuffer(current)){const n=current.length;add('{"type":"Buffer","data":[]}'.length);if(n&&2*n-1>limit-bytes)throw fail();for(let i=0;i<n;i++){if(i)add(1);add(String(current[i]).length);}continue;}
  const array=Array.isArray(current);if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(current)))throw fail();if(held.has(current))throw fail();held.add(current);add(2);
  // pg arrays are dense. Refuse sparse/custom arrays rather than invoking a
  // getter/serializer or interpreting an absent member as captured data.
  const iterator=array?(function*(){for(let i=0;i<current.length;i++)yield String(i);})():keys(current);frames.push({object:current,array,iterator,seen:false});
 }
 return bytes;
}
module.exports={LIMIT,jsonBytes};
