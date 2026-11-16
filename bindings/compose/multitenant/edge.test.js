'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const edge = require('./edge');
const template = fs.readFileSync(require('node:path').join(__dirname, 'nginx.compose.conf'), 'utf8');
test('edge budgets new handshakes separately from existing sessions and preserves trusted Host handling', () => {
  const rendered = edge.render(template, { replicas: 2, source: { NS_EDGE_CONNECTIONS_PER_IP: '300', NS_EDGE_HANDSHAKES_PER_SECOND: '20', NS_EDGE_HANDSHAKE_BURST: '40' } });
  assert.match(rendered, /map \$arg_sid \$handshake_client \{ "" \$binary_remote_addr; default ""; \}/);
  assert.match(rendered, /worker_connections 16384;/); assert.match(rendered, /worker_rlimit_nofile 65536;/);
  assert.match(rendered, /rate=20r\/s/); assert.match(rendered, /limit_conn socket_connections 300;/);
  assert.match(rendered, /burst=40 nodelay/); assert.match(rendered, /server api-internal:1337 resolve;/);
  assert.match(rendered, /proxy_set_header Host \$http_host;/);
  assert.match(rendered, /proxy_set_header X-Forwarded-For '';/);
});
test('edge rejects malformed/disabled budgets and unknown templates before creating a serving config', () => {
  for (const name of ['NS_EDGE_CONNECTIONS_PER_IP', 'NS_EDGE_HANDSHAKES_PER_SECOND', 'NS_EDGE_HANDSHAKE_BURST']) for (const value of ['0', '-1', '1; allow all;', '1000001']) assert.throws(() => edge.policy({ [name]: value }));
  assert.throws(() => edge.render('missing template boundary'));
  assert.match(edge.render(template), /server api:1337 resolve;/);
});

test('worker connection capacity is explicit and bounded separately from per-IP admission', () => {
  assert.match(edge.render(template, { source: { NS_EDGE_WORKER_CONNECTIONS: '8192' } }), /worker_connections 8192;/);
  for (const value of ['0','127','32769','8192; allow all;']) assert.throws(() => edge.policy({ NS_EDGE_WORKER_CONNECTIONS: value }));
});

test('worker process budget defaults auto and accepts bounded explicit counts', () => {
  assert.match(edge.render(template, { source: {} }), /^worker_processes auto;$/m);
  for (const workers of ['1','2','64']) { const text=edge.render(template,{source:{NS_EDGE_WORKER_PROCESSES:workers}});assert.match(text,new RegExp('^worker_processes '+workers+';$','m'));assert.match(text,/worker_connections 16384;/);assert.match(text,/proxy_set_header X-Forwarded-For '';/); }
  for (const value of ['0','65','-1','1.5','01','1; include /tmp/x;','',1]) assert.throws(()=>edge.policy({NS_EDGE_WORKER_PROCESSES:value}));
  for (const text of [template.replace('worker_processes auto;',''),template+'\nworker_processes auto;']) assert.throws(()=>edge.render(text,{source:{NS_EDGE_WORKER_PROCESSES:'1'}}));
  const expected=template.replace('worker_processes auto;','worker_processes 1;');
  assert.equal(edge.render(template,{source:{NS_EDGE_WORKER_PROCESSES:'1'}}),edge.render(expected.replace('worker_processes 1;','worker_processes auto;'),{source:{NS_EDGE_WORKER_PROCESSES:'1'}}));
  assert.equal(edge.render(template,{source:{}}),edge.render(template,{source:{NS_EDGE_WORKER_PROCESSES:'auto'}}));
});
