import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlassianClient } from '../../src/atlassian.mjs';
import { atlassianFailure } from '../../src/atlassian-errors.mjs';

test('API failures retain field-level causes and status without changing retry classification', async () => {
  const client = Object.create(AtlassianClient.prototype);
  client.apiOrigin = 'https://api.example.test'; client.config = () => null;
  client.accessToken = async () => 'private-token';
  client.transport = { fetch: async () => new Response(JSON.stringify({ errors: { timeSpentSeconds: 'Time spent must be at least 60 seconds.' } }), { status: 400 }) };
  await assert.rejects(client.request('/ex/jira/site/rest/api/3/issue/123/worklog', { method: 'POST', body: {} }), error => {
    assert.equal(error.status, 400); assert.equal(error.code, 'rejected');
    assert.match(error.message, /Jira 업무 로그 동기화 실패 \(HTTP 400\)/);
    assert.match(error.message, /timeSpentSeconds: Time spent must be at least 60 seconds/);
    return true;
  });
  client.transport.fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(client.request('/issue'), error => error.code === 'unconfirmed' && /HTTP 503/.test(error.message));
});

test('diagnostics omit credentials, unrelated response data and unbounded details', async () => {
  const response = new Response(JSON.stringify({
    errorMessages: ['Bearer secret-one access_token=secret-two private-token https://example.test/?token=secret-three'],
    errors: { client_secret: 'secret-four', summary: 'Required field' }, debug: 'secret-five'
  }), { status: 400 });
  const message = await atlassianFailure(response, { token: 'private-token' });
  assert.doesNotMatch(message, /secret-one|secret-two|private-token|secret-three|secret-four|secret-five/);
  assert.match(message, /summary: Required field/);
  const many = await atlassianFailure(new Response(JSON.stringify({ errorMessages: Array(100).fill('x'.repeat(1000)) }), { status: 400 }));
  assert.ok(many.length < 2000);
});

for (const body of ['<html>proxy error</html>', '{}', '{invalid', 'x'.repeat(70000)]) {
  test(`missing or invalid error detail uses an honest fallback (${body.length} bytes)`, async () => {
    const message = await atlassianFailure(new Response(body, { status: 400 }));
    assert.match(message, /HTTP 400/); assert.match(message, /구체적인 오류 원인을 제공하지 않았거나/);
    assert.doesNotMatch(message, /proxy error|필수 필드/);
  });
}
