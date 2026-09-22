import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, pair } from '../helpers.mjs';
import { atlFixture, authorize, createIssue, adfText } from '../fixtures/atlassian.mjs';
import { AtlassianClient } from '../../src/atlassian.mjs';
import { KeychainClientCredentials, KeychainTokens } from '../../src/credentials.mjs';
import { isJiraWiki } from '../../apps/web/description-syntax.js';
import { descriptionHTML } from '../../apps/web/description.js';
import { jiraDescription } from '../../src/jira-adf.mjs';

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

test('format detection skips complete fences and literal macro bodies before choosing the first real heading', () => {
  for (const marker of ['`', '~']) {
    const source = `${marker.repeat(4)}\n${marker.repeat(3)}\nh2. fenced example\n${marker.repeat(4)}\n## Markdown title`;
    assert.equal(isJiraWiki(source), false);
    assert.deepEqual(nodes(jiraDescription(source)).filter(node => node.type === 'heading').map(node => node.content[0].text), ['Markdown title']);
  }
  for (const macro of ['code', 'noformat', 'panel', 'quote']) {
    const source = `{${macro}}\n# literal heading\n{${macro}}\nh2. 위키 제목`;
    assert.equal(isJiraWiki(source), true);
    assert.deepEqual(nodes(jiraDescription(source)).filter(node => node.type === 'heading').map(node => node.content[0].text), ['위키 제목']);
  }
});

test('raw HTML attributes and wiki image options preserve inline syntax as literal source', () => {
  const literals = ['<img alt="*literal stars*" data-doc="[label|https://example.test]">', '!chart.png|title=*literal stars*!', '<a title="quoted > *stars*" data-code="{{literal}}">'];
  const source = `h2. 참고사항\n${literals.join('\n')}`, adf = jiraDescription(source);
  for (const literal of literals) assert.ok(text(adf).includes(literal));
  assert.ok(nodes(adf).every(node => !node.marks?.length));
  const escaped = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const html = descriptionHTML(source, escaped);
  for (const literal of literals) assert.ok(html.includes(escaped(literal)));
  assert.doesNotMatch(html, /<(?:a|img|strong|code)(?:>|\s)/);
  for (const literal of literals) assert.ok(text(jiraDescription(`h2. 참고사항\n*outside ${literal} outside*`)).includes(literal), 'outer delimiters must not consume syntax inside a literal resource');
});

test('Jira wiki source stays unchanged while create and update send the five sections and inline formatting as ADF', async t => {
  const { h, f, client, setDescription } = await setup(t);
  const headings = ['배경', '목표', '요구사항', '작업 범위', '참고사항'];
  const description = 'h2. 배경\n* 기존의 *초대 실패*를 확인했습니다.\n\nh2. 목표\n* 재초대 흐름을 명확히 합니다.\n\nh2. 요구사항\n* [관련 명세|https://example.com/spec?q=1&v=2]\n* *{{invite(user)}}* 호출\n\nh2. 작업 범위\n* 생성 API\n* 상태 화면\n\nh2. 참고사항\n* 검증 전 초안입니다.';
  const item = await setDescription(description), linked = await createIssue(h, item);
  const created = f.state.issues[0].fields.description, all = nodes(created);
  assert.equal(f.state.issues[0].fields.summary, item.title);
  assert.deepEqual(created.content.filter(node => node.type === 'heading').map(node => [node.attrs.level, node.content[0].text]), headings.map(value => [2, value]));
  assert.deepEqual(created.content.map(node => node.type), headings.flatMap(() => ['heading', 'bulletList']));
  assert.deepEqual(all.find(node => node.text === '초대 실패').marks, [{ type: 'strong' }]);
  assert.deepEqual(all.find(node => node.text === '관련 명세').marks, [{ type: 'link', attrs: { href: 'https://example.com/spec?q=1&v=2' } }]);
  assert.deepEqual(all.find(node => node.text === 'invite(user)').marks, [{ type: 'code' }]);
  assert.equal((await h.manager(`/items/${item.id}`)).item.description, description);
  const changed = description.replace('검증 전 초안입니다.', '*검토 완료*');
  await client.updateJiraIssue(linked.issue, { title: '확정한 업무 제목', description: changed });
  const request = f.state.calls.find(call => call.method === 'PUT' && call.path.endsWith('/issue/1'));
  assert.equal(request.body.fields.summary, '확정한 업무 제목');
  assert.deepEqual(request.body.fields.description.content.filter(node => node.type === 'heading').map(node => node.content[0].text), headings);
  assert.deepEqual(nodes(request.body.fields.description).find(node => node.text === '검토 완료').marks, [{ type: 'strong' }]);
  assert.equal((await h.manager(`/items/${item.id}`)).item.description, description, 'sending a Jira update must not rewrite saved source');
});

test('Jira wiki macros, resources, raw HTML and unsafe links remain literal in issue ADF', async t => {
  const { f, client } = await setup(t), issue = f.addIssue();
  const source = 'h2. 참고사항\n* [위험|javascript:alert(1)]\n* [첨부|data:text/html,hello]\n* [계정|https://user:pass@example.com]\n* !https://example.com/image.png!\n* <img src=x onerror=alert(1)>\n* {toc}\n\n{panel:title=*문자 그대로*}\nh2. 제목 아님\n* 강조 아님\n{panel}\n\n{code:html}\n<script>alert(1)</script>\n\nh2. 코드 속 제목\n{code}';
  await client.updateJiraIssue({ cloud_id: 'cloud-test', id: issue.id }, { title: '안전한 위키 미리보기', description: source });
  const adf = issue.fields.description, all = nodes(adf);
  assert.equal(all.filter(node => node.type === 'heading').length, 1);
  assert.ok(all.every(node => ['doc', 'heading', 'paragraph', 'text', 'hardBreak', 'bulletList', 'listItem'].includes(node.type)));
  assert.ok(all.every(node => !node.marks?.length));
  assert.ok(all.every(node => node.type !== 'text' || node.text.length > 0), 'blank macro lines use hardBreak instead of invalid empty ADF text nodes');
  for (const literal of ['[위험|javascript:alert(1)]', '[첨부|data:text/html,hello]', '[계정|https://user:pass@example.com]',
    '!https://example.com/image.png!', '<img src=x onerror=alert(1)>', '{toc}', '{panel:title=*문자 그대로*}', 'h2. 제목 아님', '* 강조 아님', '<script>alert(1)</script>', 'h2. 코드 속 제목']) assert.ok(text(adf).includes(literal), literal);
});

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
