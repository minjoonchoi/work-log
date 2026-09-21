import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, eventually } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h);
  h.env.HARNESS_TEST_SESSION_SUMMARIES = '0';
  h.env.HARNESS_TEST_WRITING_FIXTURE = JSON.stringify({ delayMs: 200 });
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
const sample = (agent, title, start = '09:00:00', end = '09:05:00') =>
  pair(agent, `2026-09-17T${start}+09:00`, `2026-09-17T${end}+09:00`, 'first', { text: title });
const post = body => ({ method: 'POST', body });
const detail = item => h.manager(`/items/${item.id}`);
const row = (page, item) => page.locator(`.item-row[data-id="${item.id}"]`);
const tags = async item => (await detail(item)).item.tags;
const sorted = values => [...values].sort();
async function setTags(item, values) {
  const current = await detail(item);
  return h.manager(`/items/${item.id}/tags`, { method: 'PUT', body: { version: current.item.version, tags: values } });
}
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('heading', { name: '업무 목록', exact: true })).toBeVisible();
}
async function openEditor(page, item) {
  await row(page, item).locator('.item-open').click();
  await page.getByRole('button', { name: '업무 유형 태그 편집', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '업무 유형 태그 편집', exact: true })).toBeVisible();
}
async function addTag(page, value) {
  await page.getByLabel('새 태그', { exact: true }).fill(value);
  await page.locator('#add-item-tag').click();
}
async function saveTags(page) {
  await page.locator('#save-item-tags').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}
const historyIds = data => data.events.filter(record => record.role === 'user' && ['input', 'output'].includes(record.kind)).map(record => record.uid).sort();

test('local tags support suggestions, custom text, removal and restart without OAuth or changing metadata protection', async ({ page }) => {
  await h.ingest(sample('local-tags', '로컬 분류할 업무'));
  const item = (await h.manager('/items'))[0], before = await detail(item);
  await open(page); await openEditor(page, item);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Jira');
  await dialog.locator('[data-suggest-tag]').filter({ hasText: /^기획$/ }).click();
  await addTag(page, '  고객   조사  ');
  await addTag(page, '고객 조사');
  await page.screenshot({ path: 'output/playwright/item-tags-editor.png', fullPage: true });
  await addTag(page, '<img onerror=alert(1)>');
  await expect(dialog.locator('[data-remove-tag]')).toHaveCount(3);
  await expect(dialog.locator('img')).toHaveCount(0);
  await dialog.getByRole('button', { name: '태그기획 삭제', exact: true }).click();
  await saveTags(page);
  const expected = ['고객 조사', '<img onerror=alert(1)>'];
  expect(sorted(await tags(item))).toEqual(sorted(expected));
  expect((await detail(item)).item.metadata_protected).toBe(before.item.metadata_protected);
  expect((await detail(item)).metadata_rewrite).toBeNull();
  await expect(page.locator('.item-type-tags .tag-chip')).toHaveCount(2);
  await expect(row(page, item).locator('.item-tags .tag-chip')).toHaveCount(2);
  await expect(page.locator('.item-type-tags img')).toHaveCount(0);
  await h.stop('manager'); await h.start('manager'); await open(page);
  expect(sorted(await tags(item))).toEqual(sorted(expected));
  await expect(row(page, item).locator('.tag-chip')).toHaveCount(2);
  await openEditor(page, item);
  while (await dialog.locator('[data-remove-tag]').count()) await dialog.locator('[data-remove-tag]').first().click();
  await saveTags(page); expect(await tags(item)).toEqual([]);
  await expect(page.locator('.item-type-tags')).toContainText('미분류');
  expect(f.state.tokenCalls).toHaveLength(0); expect(f.state.calls).toHaveLength(0);
});

test('tag filtering combines with title/description and Jira filters, while changes clear bulk selections', async ({ page }) => {
  await h.ingest([...sample('tags-linked', '연결된 개발'), ...sample('tags-free', '연결 없는 개발', '10:00:00', '10:05:00'),
    ...sample('tags-none', '아직 미분류', '11:00:00', '11:05:00')]);
  const items = await h.manager('/items'), linked = items.find(item => item.title === '연결된 개발');
  const free = items.find(item => item.title === '연결 없는 개발');
  await setTags(linked, ['개발', '검토']); await setTags(free, ['개발']);
  const current = (await detail(free)).item;
  await h.manager(`/items/${free.id}`, { method: 'PATCH', body: { version: current.version, title: current.title, description: '설명 검색 전용 고유근거' } });
  await authorize(h); const issue = f.addIssue({ summary: '기존 이슈' }, 'TEAM-88');
  await h.manager(`/items/${linked.id}/jira/link`, post({ operation_id: 'tags-existing-jira-link', version: (await detail(linked)).item.version,
    cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
  await open(page); const filter = page.getByLabel('업무 유형 필터');
  await expect(filter.locator('option[value="tag:개발"]')).toContainText('2');
  await page.screenshot({ path: 'output/playwright/item-tags-list.png', fullPage: true });
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check();
  await filter.selectOption('tag:개발');
  await expect(page.locator('.item-open')).toHaveText(['연결 없는 개발', '연결된 개발']);
  await expect(page.locator('.item-row input:checked')).toHaveCount(0); await expect(page.locator('#delete-items')).toBeDisabled();
  await page.getByLabel('Jira 연결 필터').selectOption('unlinked'); await page.getByLabel('업무 검색').fill('고유근거');
  await expect(page.locator('.item-open')).toHaveText(['연결 없는 개발']);
  await page.getByLabel('업무 검색').fill(''); await page.getByLabel('Jira 연결 필터').selectOption('all');
  await filter.selectOption('untagged'); await expect(page.locator('.item-open')).toHaveText(['아직 미분류']);
  await filter.selectOption('tag:검토'); await expect(page.locator('.item-open')).toHaveText(['연결된 개발']);
  expect(f.state.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

test('explicit metadata regeneration preserves independent tags and does not protect future automatic metadata', async ({ page }) => {
  await h.ingest(sample('tags-rewrite', '권한별 요구사항과 수용 조건을 정리했습니다.'));
  const item = (await h.manager('/items'))[0]; await setTags(item, ['기획', '검토']);
  const before = await detail(item); expect(before.item.metadata_protected).toBe(0);
  await open(page); await row(page, item).locator('.item-open').click();
  await page.getByRole('button', { name: '제목·설명 다시 작성', exact: true }).click();
  const completed = await eventually(() => detail(item), data => data.metadata_rewrite?.state === 'completed', 20000);
  await expect(page.locator('.metadata-writing .writing-status')).toContainText('작성 완료');
  expect(sorted(completed.item.tags)).toEqual(['검토', '기획']);
  expect(completed.item.metadata_protected).toBe(0);
  expect(historyIds(completed)).toEqual(historyIds(before));
  await expect(page.locator('.item-type-tags .tag-chip')).toHaveCount(2);
  expect(f.state.calls).toHaveLength(0);
});

test('merging unions distinct tags once and preserves every original session, then aliases reflect later tag edits', async ({ page }) => {
  await h.ingest([...sample('tags-merge-a', '태그 병합 대표'), ...sample('tags-merge-b', '태그 병합 소속', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), target = items.find(item => item.title === '태그 병합 대표'), source = items.find(item => item.id !== target.id);
  await setTags(target, ['기획', '설계']); await setTags(source, ['설계', '개발']);
  const before = await Promise.all(items.map(detail));
  await open(page); await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check();
  await page.locator('#merge').click(); await page.getByLabel('대표 업무', { exact: true }).selectOption(target.id);
  await page.getByRole('button', { name: '하나로 병합', exact: true }).click();
  await expect(page.locator('.item-row')).toHaveCount(1); await expect(page.locator('.item-type-tags .tag-chip')).toHaveCount(3);
  const merged = await detail(target);
  expect(sorted(merged.item.tags)).toEqual(sorted(['기획', '설계', '개발']));
  expect(merged.sessions.map(session => session.id).sort()).toEqual(before.flatMap(data => data.sessions.map(session => session.id)).sort());
  expect(historyIds(merged)).toEqual(before.flatMap(historyIds).sort());
  expect((await h.manager('/tags')).find(tag => tag.name === '설계').count).toBe(1);
  await page.getByRole('button', { name: '업무 유형 태그 편집', exact: true }).click();
  await page.getByRole('button', { name: '태그설계 삭제', exact: true }).click(); await saveTags(page);
  expect(sorted(await tags(source))).toEqual(sorted(['기획', '개발']));
  expect(f.state.calls).toHaveLength(0);
});

test('trash excludes tags from active counts and restore keeps tags, original histories and late events', async ({ page }) => {
  await h.ingest(sample('tags-trash', '태그를 보존할 업무'));
  const item = (await h.manager('/items'))[0]; await setTags(item, ['운영', '주간 회고']); const before = await detail(item);
  await open(page); await row(page, item).getByRole('checkbox').check(); await page.locator('#delete-items').click();
  await page.locator('#confirm-delete').click(); await expect(page.locator('.item-row')).toHaveCount(0);
  expect(await h.manager('/tags')).toEqual([]);
  expect((await h.manager('/tags?trash=true')).map(tag => tag.name).sort()).toEqual(sorted(['운영', '주간 회고']));
  await h.ingest(pair('tags-trash', '2026-09-17T09:10:00+09:00', '2026-09-17T09:15:00+09:00', 'continued', { text: '휴지통에서도 보존한 추가 이력' }));
  await page.locator('#trash-view').click(); await expect(row(page, item).locator('.tag-chip')).toHaveCount(2);
  await row(page, item).getByRole('checkbox').check(); await page.locator('#restore-items').click(); await page.locator('#confirm-restore').click();
  await expect(page.locator('.item-row')).toHaveCount(0); await page.locator('#active-items').click();
  await expect(row(page, item).locator('.tag-chip')).toHaveCount(2);
  const restored = await detail(item); expect(sorted(restored.item.tags)).toEqual(sorted(['운영', '주간 회고']));
  expect(restored.sessions.map(session => session.id)).toEqual(before.sessions.map(session => session.id));
  expect(historyIds(restored)).toEqual(expect.arrayContaining(historyIds(before))); expect(historyIds(restored)).toHaveLength(4);
  expect((await h.manager('/tags')).every(tag => tag.count === 1)).toBe(true);
  expect(f.state.calls).toHaveLength(0);
});

test('stale tag editor keeps its draft after conflict and reloads newer saved tags only on request', async ({ page }) => {
  await h.ingest(sample('tags-conflict', '동시 편집할 업무'));
  const item = (await h.manager('/items'))[0]; await setTags(item, ['개발']);
  await open(page); await openEditor(page, item); await addTag(page, '내 초안');
  await setTags(item, ['운영']);
  const response = page.waitForResponse(reply => reply.url().endsWith(`/api/items/${item.id}/tags`) && reply.request().method() === 'PUT');
  await page.locator('#save-item-tags').click(); expect((await response).status()).toBe(409);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#tag-error')).toBeVisible(); await expect(dialog.locator('#reload-item-tags')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '태그내 초안 삭제', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '태그개발 삭제', exact: true })).toBeVisible();
  expect(await tags(item)).toEqual(['운영']);
  await dialog.locator('#reload-item-tags').click();
  await expect(dialog.getByRole('button', { name: '태그운영 삭제', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '태그내 초안 삭제', exact: true })).toHaveCount(0);
  await addTag(page, '다시 확인'); await saveTags(page);
  expect(sorted(await tags(item))).toEqual(sorted(['운영', '다시 확인']));
  expect(f.state.calls).toHaveLength(0);
});

test('a tag editor opened before a merge cannot overwrite the representative until its combined tags are reloaded', async ({ page }) => {
  await h.ingest([...sample('tags-stale-source', '병합 전 편집 대상'), ...sample('tags-stale-target', '병합 후 대표 업무', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), source = items.find(item => item.title === '병합 전 편집 대상');
  const target = items.find(item => item.id !== source.id);
  await setTags(source, ['설계']); await setTags(target, ['운영']);
  await open(page); await openEditor(page, source); await addTag(page, '확인 전 초안');
  await h.manager('/merge', post({ ids: [source.id, target.id], target: target.id, operation_id: 'merge-while-tag-editor-open' }));
  const response = page.waitForResponse(reply => reply.url().endsWith(`/api/items/${source.id}/tags`) && reply.request().method() === 'PUT');
  await page.locator('#save-item-tags').click(); expect((await response).status()).toBe(409);
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('#tag-error')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '태그확인 전 초안 삭제', exact: true })).toBeVisible();
  expect(sorted(await tags(target))).toEqual(sorted(['설계', '운영']));
  await dialog.locator('#reload-item-tags').click();
  await expect(dialog.getByRole('button', { name: '태그운영 삭제', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '태그확인 전 초안 삭제', exact: true })).toHaveCount(0);
  await addTag(page, '검토'); await saveTags(page);
  expect(sorted(await tags(target))).toEqual(sorted(['설계', '운영', '검토']));
  await expect(page.locator('.work-item-title')).toHaveText(target.title); await expect(page.locator('.session-card')).toHaveCount(2);
  expect(f.state.calls).toHaveLength(0);
});

test('a delayed tag save persists without closing or resetting a settings dialog opened afterward', async ({ page }) => {
  await h.ingest(sample('tags-delayed-save', '늦은 저장 응답을 확인할 업무'));
  const item = (await h.manager('/items'))[0];
  await open(page); await openEditor(page, item); await addTag(page, '검토');
  let release, saved = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/items/${item.id}/tags`, async route => {
    const response = await route.fetch();
    saved = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.locator('#save-item-tags').click();
    await expect.poll(() => saved).toBe(true);
    expect(await tags(item)).toEqual(['검토']);
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    await page.locator('#automation-settings').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '자동 작성 설정', exact: true })).toBeVisible();
    const settingsInput = dialog.getByLabel('에이전트 응답 수');
    await settingsInput.fill('11');
    release();
    await expect(page.locator('#toast')).toHaveText('업무 유형 태그를 저장했습니다.');
    await expect(dialog.getByRole('heading', { name: '자동 작성 설정', exact: true })).toBeVisible();
    await expect(settingsInput).toHaveValue('11'); await expect(settingsInput).toBeFocused();
    expect(await tags(item)).toEqual(['검토']);
    expect(f.state.calls).toHaveLength(0);
  } finally { release(); }
});
