import test from 'node:test';
import assert from 'node:assert/strict';
import {bootAuditServer} from './audit-server-helper.mjs';

test('HTTP audit: malformed input must be a client error, with the server still usable', async t => {
  const server = await bootAuditServer();
  try {
    for (const route of ['/api/login', '/api/provider', '/api/launch-login']) {
      for (const body of ['null', '[]', '[{}]', '"text"', 'false', '123']) {
        await t.test(`${route} rejects JSON ${body} as 400`, async () => {
          const response = await fetch(server.origin + route, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body,
          });
          assert.equal(response.status, 400, await response.text());
        });
      }
    }
    await t.test('invalid JSON is 400 and oversized JSON is 413', async () => {
      const send = body => fetch(server.origin + '/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body,
      });
      assert.equal((await send('{')).status, 400);
      assert.equal((await send(JSON.stringify({token: 'a'.repeat(90001)}))).status, 413);
    });
    await t.test('normal login and state read still work after input failures', async () => {
      const response = await fetch(server.origin + '/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: server.admin}),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      assert.equal((await fetch(server.origin + '/api/relay', {headers: {Cookie: cookie}})).status, 200);
    });
  } finally { await server.close(); }
});
