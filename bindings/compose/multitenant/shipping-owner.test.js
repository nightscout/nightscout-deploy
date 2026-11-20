'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {qualify} = require('./fixtures/shipping-owner.cjs');

test('both phases use the private owner listener, registered host and same authorized session', async () => {
  const tenant = {id: 'a', host: 'a.example.test', ownerSubject: 'owner'};
  const requestId = '9f4837f3-531b-4156-9c04-30c0aa80142c';
  for (const session of ['primer', 'renew']) {
    const calls = [];
    const request = async (origin, route, options) => {
      calls.push(origin);
      if (origin === 'http://admin') {
        assert.equal(route, '/v1/tenants/a/management-sessions');
        assert.deepEqual(options.body, {subjectId: tenant.ownerSubject, requestId});
        assert.equal(options.headers['idempotency-key'], requestId);
        return {status: 200, body: {token: 'synthetic-renewed'}};
      }
      assert.equal(origin, 'http://tenant-admin:1341');
      assert.equal(route, '/api/v2/authorization/roles');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.host, tenant.host);
      assert.equal(options.headers.authorization, 'Bearer synthetic-renewed');
      return {status: 200, body: options.body};
    };
    for (const phase of ['before', 'after']) {
      const input = {tenant, adminOrigin: 'http://admin', session, requestId, request, phase};
      await qualify(input);
      await assert.rejects(qualify({...input, session: 'primer', request: async () => ({status: 401, body: {}})}), /owner (session issuance|role creation) refused/);
    }
    assert.equal(calls.filter(origin => origin === 'http://admin').length, 2);
  }
});
