import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair } from '../helpers.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';
import { AtlassianClient } from '../../src/atlassian.mjs';
import { KeychainClientCredentials, KeychainTokens } from '../../src/credentials.mjs';

async function setup(t) {
  const h = new Harness(), f = await atlFixture(h);
  t.after(async () => { await h.close(); await f.close(); });
  await h.start('manager'); await authorize(h);
  const client = new AtlassianClient({ dir: h.dir, apiOrigin: f.origin, authOrigin: f.origin,
    credentials: new KeychainClientCredentials(h.dir, h.env.HARNESS_KEYCHAIN_BIN),
    tokens: new KeychainTokens(h.dir, h.env.HARNESS_KEYCHAIN_BIN) });
  await h.ingest(pair('jira-description', '09:00:00', '09:05:00'));
  const setDescription = async description => {
    const item = (await h.manager('/items'))[0];
    await h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title: '구조화된 업무 설명', description } });
    return (await h.manager('/items'))[0];
  };
  return { h, f, client, setDescription };
}
const nodes = doc => [doc, ...(doc.content || []).flatMap(nodes)];
const text = doc => doc.type === 'text' ? doc.text : doc.type === 'hardBreak' ? '\n'
  : (doc.content || []).map(text).join(['doc', 'bulletList', 'orderedList', 'listItem'].includes(doc.type) ? '\n' : '');

test('work item Markdown remains the source while Jira create and update send headings, lists, strong and links as ADF', async t => {
  const { h, f, client, setDescription } = await setup(t);
  const description = '## 작업 배경\n기존 절차가 **복잡**합니다.\n관찰된 문제를 줄입니다.\n\n## 목적\n[관련 명세](https://example.com/spec?q=1&v=2)를 구현합니다.\n\n## 범위\n- 생성 API\n- 상태 화면\n\n## 결과\n3. 설계 완료\n4. 테스트 통과';
  const item = await setDescription(description), linked = await createIssue(h, item);
  const created = f.state.issues[0].fields.description;
  assert.equal(created.type, 'doc'); assert.equal(created.version, 1);
  assert.deepEqual(created.content.map(node => node.type), ['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'bulletList', 'heading', 'orderedList']);
  assert.deepEqual(created.content.filter(node => node.type === 'heading').map(node => [node.attrs.level, node.content[0].text]),
    [[2, '작업 배경'], [2, '목적'], [2, '범위'], [2, '결과']]);
  assert.deepEqual(created.content[1].content.find(node => node.text === '복잡').marks, [{ type: 'strong' }]);
  assert.equal(created.content[1].content.filter(node => node.type === 'hardBreak').length, 1);
  assert.equal(created.content[3].content[0].marks[0].attrs.href, 'https://example.com/spec?q=1&v=2');
  assert.equal(created.content[5].content.length, 2); assert.equal(created.content[7].attrs.order, 3);
  assert.equal((await h.manager(`/items/${item.id}`)).item.description, description);
  const changed = description.replace('설계 완료', '**설계·검토 완료**');
  assert.equal(await client.updateJiraIssue(linked.issue, { title: '확정한 업무', description: changed }), null);
  const request = f.state.calls.find(call => call.method === 'PUT' && call.path.endsWith('/issue/1'));
  assert.equal(request.body.fields.summary, '확정한 업무');
  assert.deepEqual(request.body.fields.description.content[7].content[0].content[0].content[0],
    { type: 'text', text: '설계·검토 완료', marks: [{ type: 'strong' }] });
  assert.deepEqual(f.state.issues[0].fields.description, request.body.fields.description);
});

test('legacy descriptions retain exact lines on create and update; unsupported HTML and unsafe links remain literal text', async t => {
  const { h, f, client, setDescription } = await setup(t);
  const legacy = '첫째 줄 <태그> & 원문\n\n둘째 줄\n';
  const item = await setDescription(legacy), linked = await createIssue(h, item);
  assert.equal(adfText(f.state.issues[0].fields.description), legacy);
  await client.updateJiraIssue(linked.issue, { title: '기존 형식', description: legacy });
  assert.equal(adfText(f.state.issues[0].fields.description), legacy);
  const unsafe = '## 작업 배경\n<script>alert("x")</script>\n<img src=x onerror=alert(1)>\n\n## 범위\n- [위험](javascript:alert(1))\n- [첨부](data:text/html,hello)\n- ![이미지](https://example.com/image.png)\n\n```html\n## 제목 아님\n**강조 아님**\n```';
  await client.updateJiraIssue(linked.issue, { title: '문자 그대로 보존', description: unsafe });
  const adf = f.state.issues[0].fields.description, all = nodes(adf);
  assert.equal(all.filter(node => node.type === 'heading').length, 2);
  assert.ok(all.every(node => ['doc', 'heading', 'paragraph', 'text', 'hardBreak', 'bulletList', 'listItem'].includes(node.type)));
  assert.ok(all.every(node => !node.marks?.length), 'HTML, image syntax, unsafe links and fenced text never become active nodes');
  for (const literal of ['<script>alert("x")</script>', '<img src=x onerror=alert(1)>', '[위험](javascript:alert(1))',
    '[첨부](data:text/html,hello)', '![이미지](https://example.com/image.png)', '## 제목 아님', '**강조 아님**']) {
    assert.ok(text(adf).includes(literal), literal);
  }
});

test('worklog comments keep literal headings, bullets, links and exact line breaks independently from issue description formatting', async t => {
  const { f, client } = await setup(t), issue = f.addIssue();
  const comment = '## 작업 제목\n- **강조 원문**\n[근거](https://example.com)\n\n마지막 줄';
  const row = { operation_id: 'literal-worklog-operation', session_id: 'literal-session', source_digest: 'snapshot',
    payload: JSON.stringify({ comment, started: '2026-09-17T09:00:00Z', seconds: 300 }) };
  const written = await client.writeWorklog({ cloud_id: 'cloud-test', id: issue.id }, row);
  assert.equal(adfText(f.state.worklogs[0].comment), comment);
  await client.writeWorklog({ cloud_id: 'cloud-test', id: issue.id }, { ...row, worklog_id: written.id });
  assert.equal(adfText(f.state.worklogs[0].comment), comment);
  assert.ok(nodes(f.state.worklogs[0].comment).every(node => !node.marks?.length && node.type !== 'heading'));
  assert.equal(f.state.worklogs.length, 1);
});

test('issue update checks write scopes, preserves known REST failures and never retries an unconfirmed write', async t => {
  const { f, client } = await setup(t), issue = f.addIssue(), target = { cloud_id: 'cloud-test', id: issue.id };
  const body = { title: '업무', description: '## 목적\n요구사항 확인' };
  f.state.scopes = ['read:jira-work'];
  await assert.rejects(client.updateJiraIssue(target, body), /쓰기 권한/);
  assert.equal(f.state.calls.filter(call => call.method === 'PUT').length, 0);
  f.state.scopes.push('write:jira-work'); f.state.issueUpdateFailure = 403;
  await assert.rejects(client.updateJiraIssue(target, body), error => error.status === 403 && error.code === 'rejected');
  f.state.issueUpdateFailure = null; f.state.issueUpdateResponseLost = true;
  await assert.rejects(client.updateJiraIssue(target, body), error => error.code === 'unconfirmed');
  assert.equal(f.state.calls.filter(call => call.method === 'PUT').length, 2);
  assert.equal(issue.fields.summary, body.title, 'an unconfirmed response may still have applied the update');
});
