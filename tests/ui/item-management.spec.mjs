import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Harness, pair, event } from '../helpers.mjs';
import { readEndpoint } from '../../src/shared.mjs';
import { atlFixture, authorize } from '../fixtures/atlassian.mjs';

let h, f;
test.beforeEach(async ({ context }) => {
  h = new Harness(); f = await atlFixture(h); h.env.HARNESS_TEST_SESSION_SUMMARIES = '0';
  await h.start('runtime'); await h.start('manager');
  await context.addInitScript(token => window.__HARNESS_TOKEN__ = token, fs.readFileSync(path.join(h.dir, 'token'), 'utf8'));
});
test.afterEach(async () => { await h.close(); await f.close(); });
const post = body => ({ method: 'POST', body });
const detail = item => h.manager(`/items/${item.id}`);
const sample = (agent, title, start = '09:00:00', end = '09:05:00', turn = 'first') =>
  pair(agent, `2026-09-17T${start}+09:00`, `2026-09-17T${end}+09:00`, turn, { text: title });
async function open(page) {
  await page.goto(`http://127.0.0.1:${readEndpoint(h.dir, 'manager').port}`);
  await expect(page.getByRole('heading', { name: '업무 목록', exact: true })).toBeVisible();
}
async function edit(item, description, title = item.title) {
  return h.manager(`/items/${item.id}`, { method: 'PATCH', body: { version: item.version, title, description } });
}
async function connect(item, operation = 'item-management-jira-link') {
  await authorize(h); const issue = f.addIssue({ summary: '외부 이슈 원문' }, 'TEAM-42');
  await h.manager(`/items/${item.id}/jira/link`, post({ operation_id: operation, version: item.version,
    cloud_id: 'cloud-test', issue_id: issue.id, key: issue.key }));
  return issue;
}
const row = (page, item) => page.locator(`.item-row[data-id="${item.id}"]`);
const displayedIds = page => page.locator('.item-row').evaluateAll(rows => rows.map(row => row.dataset.id));
const historyIds = data => data.events.filter(record => record.role === 'user' && ['input', 'output'].includes(record.kind)).map(record => record.uid).sort();
function recordMutations(page) {
  const requests = [];
  page.on('request', request => {
    const route = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ['/api/items/delete', '/api/items/restore', '/api/merge'].includes(route)) {
      requests.push({ route, body: request.postDataJSON() });
    }
  });
  return requests;
}

test('items sort by observed activity descending and title/description search does not mistake late ingestion for recent work', async ({ page }) => {
  await h.ingest([...sample('early', '오전 설계', '09:00:00', '09:05:00'),
    ...sample('latest', '최근 계획', '11:00:00', '11:05:00'), ...sample('middle', '중간 개발', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), early = items.find(item => item.title === '오전 설계'), latest = items.find(item => item.title === '최근 계획');
  const middle = items.find(item => item.title === '중간 개발'); await edit(latest, '설명에만 존재하는 고유진행위험');
  await open(page); await expect(page.locator('.item-open')).toHaveText(['최근 계획', '중간 개발', '오전 설계']);
  await expect(page.locator('#items-view')).toContainText('최근 활동순');
  await page.getByLabel('업무 검색').fill('오전 설계'); await expect(page.locator('.item-open')).toHaveText(['오전 설계']);
  await page.getByLabel('업무 검색').fill('고유진행위험'); await expect(page.locator('.item-open')).toHaveText(['최근 계획']);
  await page.getByLabel('업무 검색').fill(''); await expect(page.locator('.item-row')).toHaveCount(3);
  await h.ingest([event('early', 'output', '2026-09-17T09:04:00+09:00', 'first', { text: '늦게 수집한 예전 응답' })]);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  expect(await displayedIds(page)).toEqual([latest.id, middle.id, early.id]);
  await h.ingest(sample('early', '가장 최근 후속 활동', '12:00:00', '12:05:00', 'second'));
  await expect(page.locator('.item-open')).toHaveText(['오전 설계', '최근 계획', '중간 개발']);
});

test('Jira unlinked filtering combines with search and follows a linked alias after bulk merge', async ({ page }) => {
  await h.ingest([...sample('linked', 'Jira 연결 업무'), ...sample('target', '합칠 대표 업무', '10:00:00', '10:05:00'),
    ...sample('unlinked', '독립 미연결 업무', '11:00:00', '11:05:00')]);
  const items = await h.manager('/items'), linked = items.find(item => item.title === 'Jira 연결 업무'), target = items.find(item => item.title === '합칠 대표 업무');
  const unlinked = items.find(item => item.title === '독립 미연결 업무'); await edit(unlinked, '검색 전용 미연결설명'); await connect(linked);
  await open(page); await page.getByLabel('Jira 연결 필터').selectOption('unlinked');
  await expect(page.locator('.item-open')).toHaveText(['독립 미연결 업무', '합칠 대표 업무']);
  await page.getByLabel('업무 검색').fill('미연결설명'); await expect(page.locator('.item-open')).toHaveText(['독립 미연결 업무']);
  await page.getByLabel('업무 검색').fill(''); await page.getByLabel('Jira 연결 필터').selectOption('all');
  await row(page, linked).getByRole('checkbox').check(); await row(page, target).getByRole('checkbox').check();
  await page.getByRole('button', { name: '선택한 업무 병합' }).click();
  await page.getByLabel('대표 업무', { exact: true }).selectOption(target.id); await page.getByRole('button', { name: '하나로 병합', exact: true }).click();
  await expect(page.locator('.item-row')).toHaveCount(2); await page.getByRole('button', { name: '상세 닫기' }).click();
  await page.getByLabel('Jira 연결 필터').selectOption('unlinked'); await expect(page.locator('.item-open')).toHaveText(['독립 미연결 업무']);
  await page.getByLabel('Jira 연결 필터').selectOption('linked'); await expect(page.locator('.item-open')).toHaveText(['합칠 대표 업무']);
  expect((await detail(target)).jira_links[0].issue.key).toBe('TEAM-42');
  expect(f.state.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

test('bulk deletion previews selected visible items, cancellation sends nothing, late hooks stay in trash and restore keeps original history', async ({ page }) => {
  await h.ingest([...sample('remove-a', '선택 삭제 A'), ...sample('remove-b', '선택 삭제 B', '10:00:00', '10:05:00'),
    ...sample('keep', '계속 보이는 업무', '11:00:00', '11:05:00')]);
  const items = await h.manager('/items'), a = items.find(item => item.title === '선택 삭제 A'), b = items.find(item => item.title === '선택 삭제 B');
  const keep = items.find(item => item.title === '계속 보이는 업무'), before = await detail(a); const issue = await connect(a), originalIssue = JSON.stringify(issue);
  await open(page); const mutations = recordMutations(page);
  await page.getByLabel('업무 검색').fill('선택 삭제'); await expect(page.locator('.item-row')).toHaveCount(2);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check();
  await page.getByRole('button', { name: '선택한 업무 삭제' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: '2개 업무 삭제' })).toBeVisible();
  await expect(dialog).toContainText('선택 삭제 A'); await expect(dialog).toContainText('선택 삭제 B'); await expect(dialog).not.toContainText(keep.title);
  await expect(dialog).toContainText('이력'); await expect(dialog).toContainText('Jira');
  await dialog.getByRole('button', { name: '취소', exact: true }).click(); expect(mutations).toHaveLength(0);
  await expect(page.locator('.item-row')).toHaveCount(2);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check(); await page.getByRole('button', { name: '선택한 업무 삭제' }).click();
  await page.locator('#confirm-delete').click(); await expect(dialog).not.toBeVisible(); await expect(page.locator('.item-row')).toHaveCount(0);
  expect(mutations.filter(call => call.route.endsWith('/delete'))).toHaveLength(1);
  expect(mutations[0].body.ids.sort()).toEqual([a.id, b.id].sort()); expect(mutations[0].body.operation_id).toBeTruthy();
  await page.getByLabel('업무 검색').fill(''); await expect(page.locator('.item-open')).toHaveText([keep.title]);
  await h.ingest(sample('remove-a', '삭제 후 추가된 같은 업무 이력', '09:10:00', '09:15:00', 'second'));
  await page.getByRole('button', { name: '새로고침', exact: true }).click(); await expect(page.locator('.item-open')).toHaveText([keep.title]);
  expect((await h.manager('/items')).map(item => item.id)).toEqual([keep.id]);
  expect((await h.manager('/sessions')).every(session => ![a.id, b.id].includes(session.work_item_id))).toBe(true);
  await h.stop('manager'); await h.start('manager'); await open(page); await expect(page.locator('.item-open')).toHaveText([keep.title]);
  await page.locator('#trash-view').click(); await expect(page.locator('.item-row')).toHaveCount(2);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check(); await page.locator('#restore-items').click();
  await expect(dialog.locator('#confirm-restore')).toBeVisible(); await dialog.locator('#confirm-restore').click();
  await expect(dialog).not.toBeVisible(); await expect(page.locator('.item-row')).toHaveCount(0); await page.locator('#active-items').click();
  await expect(page.locator('.item-row')).toHaveCount(3);
  const restored = await detail(a);
  expect(restored.sessions.map(session => session.id)).toEqual(before.sessions.map(session => session.id));
  expect(historyIds(restored)).toEqual(expect.arrayContaining(historyIds(before)));
  expect(restored.events.filter(record => record.session_id === restored.sessions[0].id && ['input', 'output'].includes(record.kind))).toHaveLength(4);
  await row(page, a).locator('.item-open').click(); await page.locator('.session-card > summary').click();
  await page.locator('.session-card .raw-history > summary').click();
  await expect(page.locator('.event')).toHaveCount(4);
  for (const record of await page.locator('.event > summary').all()) await record.click();
  await expect(page.locator('.event pre')).toContainText(['삭제 후 추가된 같은 업무 이력', '삭제 후 추가된 같은 업무 이력', '선택 삭제 A', '선택 삭제 A']);
  expect(JSON.stringify(issue)).toBe(originalIssue); expect(f.state.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

test('bulk merge consolidates every selected agent session across days without rewriting session or input/output record IDs', async ({ page }) => {
  await h.ingest([...sample('merge-a', '병합 대표 업무'), ...sample('merge-a', '두 번째 작업 구간', '09:25:00', '09:30:00', 'second'),
    ...pair('merge-b', '2026-09-18T09:00:00+09:00', '2026-09-18T09:05:00+09:00', 'first', { text: '다음 날 에이전트 업무', engine: 'claude' }),
    ...sample('merge-c', '별도 기획 업무', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), target = items.find(item => item.title === '병합 대표 업무');
  const before = await Promise.all(items.map(detail));
  const sessionIds = before.flatMap(data => data.sessions.map(session => session.id)).sort(), recordIds = before.flatMap(historyIds).sort();
  expect(sessionIds).toHaveLength(4); expect(recordIds).toHaveLength(8);
  await open(page); const mutations = recordMutations(page);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check(); await page.getByRole('button', { name: '선택한 업무 병합' }).click();
  await expect(page.getByRole('dialog')).toContainText('세션 4개'); await page.getByLabel('대표 업무', { exact: true }).selectOption(target.id);
  await page.getByRole('button', { name: '하나로 병합', exact: true }).click(); await expect(page.locator('.item-row')).toHaveCount(1);
  await expect(page.locator('.session-card')).toHaveCount(4); await expect(page.locator('.work-item-title')).toHaveText(target.title);
  const merged = await detail(target);
  expect(merged.sessions.map(session => session.id).sort()).toEqual(sessionIds); expect(historyIds(merged)).toEqual(recordIds);
  expect(mutations.filter(call => call.route === '/api/merge')).toHaveLength(1);
  expect(mutations[0].body.ids.sort()).toEqual(items.map(item => item.id).sort());
  await page.getByRole('button', { name: '상세 닫기' }).click(); await page.getByLabel('목록 표시 단위').selectOption('sessions');
  await expect(page.locator('.session-row')).toHaveCount(4);
  expect(await page.locator('.session-row').evaluateAll(rows => rows.map(row => row.dataset.itemId))).toEqual(Array(4).fill(target.id));
});

test('search, Jira filter, special navigation and session mode clear selections; select-all never retains hidden items', async ({ page }) => {
  await h.ingest([...sample('selection-a', '선택 범위 A'), ...sample('selection-b', '선택 범위 B')]);
  await open(page);
  const all = page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }), remove = page.getByRole('button', { name: '선택한 업무 삭제' });
  await all.check(); await expect(remove).toBeEnabled(); await page.getByLabel('업무 검색').fill('범위 A');
  await expect(page.locator('.item-row')).toHaveCount(1); await expect(all).not.toBeChecked(); await expect(remove).toBeDisabled();
  await all.check(); await expect(page.getByRole('button', { name: '선택한 업무 병합' })).toBeDisabled();
  await page.getByLabel('Jira 연결 필터').selectOption('unlinked'); await expect(all).not.toBeChecked(); await expect(remove).toBeDisabled();
  await page.getByLabel('업무 검색').fill(''); await expect(page.locator('.item-row')).toHaveCount(2); await all.check();
  await page.getByRole('button', { name: '알림', exact: true }).click(); await page.getByRole('button', { name: '업무 목록', exact: true }).click();
  await expect(all).not.toBeChecked(); await expect(remove).toBeDisabled();
  await all.check(); await page.getByLabel('목록 표시 단위').selectOption('sessions'); await expect(remove).toBeHidden(); await expect(all).toBeHidden();
  await page.getByLabel('목록 표시 단위').selectOption('items'); await expect(all).not.toBeChecked(); await expect(remove).toBeDisabled();
  await expect(page.locator('.item-row input[type=checkbox]:checked')).toHaveCount(0);
});

test('delete confirmation rejects an item merged elsewhere and requires a fresh selection of the expanded history', async ({ page }) => {
  await h.ingest([...sample('stale-delete-a', '처음 확인한 업무 A'), ...sample('stale-delete-b', '별도 업무 B', '10:00:00', '10:05:00')]);
  const items = await h.manager('/items'), a = items.find(item => item.title === '처음 확인한 업무 A');
  const b = items.find(item => item.title === '별도 업무 B');
  const original = await Promise.all(items.map(detail));
  await open(page); const mutations = recordMutations(page);
  await row(page, a).getByRole('checkbox').check(); await page.getByRole('button', { name: '선택한 업무 삭제' }).click();
  const dialog = page.getByRole('dialog'), preview = dialog.locator('.operation-items');
  await expect(preview).toContainText(a.title); await expect(preview).not.toContainText(b.title);
  const confirmedPreview = await preview.textContent();
  await h.manager('/merge', post({ ids: [a.id, b.id], target: b.id, operation_id: 'external-merge-after-preview' }));
  await expect(page.locator('.item-row')).toHaveCount(1);
  const response = page.waitForResponse(reply => reply.url().endsWith('/api/items/delete') && reply.request().method() === 'POST');
  await dialog.locator('#confirm-delete').click(); expect((await response).status()).toBe(409);
  await expect(dialog.locator('#operation-error')).toBeVisible();
  await expect(dialog.locator('#operation-error')).toContainText(/변경|다시 확인/);
  await expect(preview).toHaveText(confirmedPreview); await expect(dialog).toBeVisible();
  expect(mutations[0].body.ids).toEqual([a.id]); expect(mutations[0].body.versions).toEqual({ [a.id]: a.version });
  expect((await h.manager('/items')).map(item => item.id)).toEqual([b.id]); expect(await h.manager('/items?trash=true')).toEqual([]);
  const merged = await detail(b);
  expect(merged.sessions.map(session => session.id).sort()).toEqual(original.flatMap(data => data.sessions.map(session => session.id)).sort());
  expect(historyIds(merged)).toEqual(original.flatMap(historyIds).sort());
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('button', { name: '선택한 업무 삭제' })).toBeDisabled();
  await row(page, b).getByRole('checkbox').check(); await page.getByRole('button', { name: '선택한 업무 삭제' }).click();
  await expect(preview).toContainText(b.title); await expect(preview).toContainText('세션 2개');
  await dialog.locator('#confirm-delete').click(); await expect(dialog).not.toBeVisible(); await expect(page.locator('.item-row')).toHaveCount(0);
  expect(mutations[1].body.ids).toEqual([b.id]); expect(mutations[1].body.versions).toEqual({ [b.id]: merged.item.version });
  const trash = await h.manager('/items?trash=true'); expect(trash).toHaveLength(1); expect(trash[0].session_count).toBe(2);
});

test('all-select deletes and restores all 101 displayed items without an arbitrary count limit', async ({ page }) => {
  await h.ingest(Array.from({ length: 101 }, (_, index) => sample(`bulk-visible-${index}`, `대량 업무 ${index}`)).flat());
  const items = await h.manager('/items'), ids = items.map(item => item.id).sort();
  await open(page); const mutations = recordMutations(page);
  await expect(page.locator('.item-row')).toHaveCount(101);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check();
  await expect(page.locator('.item-row input:checked')).toHaveCount(101);
  await page.getByRole('button', { name: '선택한 업무 삭제' }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '101개 업무 삭제' })).toBeVisible();
  await expect(dialog.locator('.operation-items li')).toHaveCount(101);
  await dialog.locator('#confirm-delete').click(); await expect(dialog).not.toBeVisible(); await expect(page.locator('.item-row')).toHaveCount(0);
  expect(mutations[0].body.ids.sort()).toEqual(ids); expect(Object.keys(mutations[0].body.versions)).toHaveLength(101);
  expect(await h.manager('/items')).toEqual([]); expect(await h.manager('/sessions')).toEqual([]);
  await page.locator('#trash-view').click(); await expect(page.locator('.item-row')).toHaveCount(101);
  await page.getByRole('checkbox', { name: '표시된 업무 전체 선택' }).check(); await page.locator('#restore-items').click();
  await expect(dialog.getByRole('heading', { name: '101개 업무 복원' })).toBeVisible();
  await dialog.locator('#confirm-restore').click(); await expect(dialog).not.toBeVisible(); await expect(page.locator('.item-row')).toHaveCount(0);
  expect(mutations[1].body.ids.sort()).toEqual(ids); expect(Object.keys(mutations[1].body.versions)).toHaveLength(101);
  await page.locator('#active-items').click(); await expect(page.locator('.item-row')).toHaveCount(101);
  expect((await h.manager('/items')).map(item => item.id).sort()).toEqual(ids);
  expect(await h.manager('/sessions')).toHaveLength(101); expect(await h.manager('/items?trash=true')).toEqual([]);
  expect(f.state.calls).toHaveLength(0);
});
