'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {checkStream}=require('./check-compose');
const fixture=()=>({services:{evaluator:{depends_on:{realtime:{condition:'service_healthy'}},volumes:[{source:'/private/evaluator',target:'/run/ns-config',read_only:true}]},pgstream:{command:['/usr/local/bin/pgstream','run','-c','/run/ns-stream/pgstream.yaml','--log-level','info'],restart:'unless-stopped',depends_on:{postgres:{condition:'service_healthy'},evaluator:{condition:'service_started'}},volumes:[{source:'/private/pgstream',target:'/run/ns-stream',read_only:true}]}}});
test('separate stream worker has platform lifecycle, fixed intake and exclusive wire credential custody',()=>{
 checkStream(fixture());
 for(const mutate of [config=>{delete config.services.pgstream;},config=>{config.services.pgstream.restart='no';},config=>{config.services.pgstream.depends_on.evaluator.condition='service_healthy';},config=>{config.services.evaluator.volumes.push(config.services.pgstream.volumes[0]);},config=>{config.services.evaluator.environment={NS_PGSTREAM_BINARY:'/synthetic'};},config=>{config.services.evaluator.depends_on.pgstream={condition:'service_healthy'};}]){const broken=fixture();mutate(broken);assert.throws(()=>checkStream(broken));checkStream(fixture());}
});
test('actual Compose and ordinary startup include exactly one private direct-binary worker',()=>{
 const yaml=fs.readFileSync(path.join(__dirname,'compose.yaml'),'utf8'),section=yaml.slice(yaml.indexOf('\n  pgstream:\n'),yaml.indexOf('\n  evaluator:\n'));
 const criterion=text=>{assert.match(text,/command: \[\/usr\/local\/bin\/pgstream, run, -c, \/run\/ns-stream\/pgstream.yaml, --log-level, info\]/,'EXTERNAL_BINARY_REQUIRED');assert.match(text,/restart: unless-stopped/,'PLATFORM_RESTART_REQUIRED');assert.match(text,/evaluator: \{condition: service_started\}/,'NO_CLINICAL_START_CYCLE');assert.match(text,/\/pgstream:\/run\/ns-stream:ro/,'DEDICATED_STREAM_WIRE_REQUIRED');assert(!/ports:|\/run\/ns-ipc/.test(text),'PRIVATE_STREAM_ONLY');};
 assert.equal((yaml.match(/^  pgstream:$/gm)||[]).length,1);criterion(section);assert.throws(()=>criterion(section.replace('restart: unless-stopped','restart: "no"')),/PLATFORM_RESTART_REQUIRED/);criterion(section);
 const launcher=fs.readFileSync(path.join(__dirname,'demo.sh'),'utf8');assert.match(launcher,/\$evaluator_services pgstream tenant-admin/,'ORDINARY_START_MUST_INCLUDE_STREAM');
});
