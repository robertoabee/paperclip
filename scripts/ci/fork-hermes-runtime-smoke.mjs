import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// All state, keys and the gateway are synthetic and confined to one CI container.
const key = 'synthetic-ci-gateway-key';
let healthCalls = 0;
const gateway = http.createServer((req, res) => {
  assert.equal(req.url, '/health');
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  healthCalls++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"status":"ok"}');
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const api = 'http://127.0.0.1:3100/api';
async function post(path, body) {
  const response = await fetch(api + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
try {
  const company = await post('/companies', { name: 'Synthetic Hermes CI' });
  assert.ok(company.id);
  for (const aiConnection of [undefined, {
    mode: 'router', connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }]) {
    const result = await post(`/companies/${company.id}/adapters/hermes_gateway/test-environment`, {
      adapterConfig: { apiBaseUrl: `http://127.0.0.1:${gateway.address().port}` },
      testCredentials: { API_SERVER_KEY: key },
      ...(aiConnection ? { aiConnection } : {}),
    });
    assert.equal(result.status, 'pass');
    assert.ok(result.checks.some(check => check.code === 'hermes_gateway_health_ok'));
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.equal(healthCalls, 2);
  console.log('PASS: real image route reaches synthetic Hermes with no provider binding and stale router; key redacted');
} finally {
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
}
