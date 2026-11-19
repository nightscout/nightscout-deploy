'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
test('platform entrypoint starts only the selected role with its container environment',()=>{
  const file=require.resolve('../entrypoint'),loaded=new Module(file,module),calls=[];
  loaded.require=name=>{assert.equal(name,'../../lib/cli');return {main:args=>calls.push(args)};};
  const argv=process.argv;
  try {process.argv=['node',file,'api'];loaded._compile(fs.readFileSync(file,'utf8'),file);}
  finally {process.argv=argv;}
  assert.deepEqual(calls,[['multitenant','api']]);
});
