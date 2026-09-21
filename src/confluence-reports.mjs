import { assert, digest, json, now, redact } from './shared.mjs';
import { confluenceStorage } from './confluence-storage.mjs';
import { reportBodyMarkdown } from '../apps/web/report-body.js';

export function buildReportStorage(detail) {
  const body = reportBodyMarkdown(detail.report.body);
  assert(body.trim(), '게시할 업무 요약 본문이 없습니다.', 409);
  const storage = confluenceStorage(body);
  assert(Buffer.byteLength(storage) <= 8 * 1024 * 1024, 'Confluence 본문이 게시 한도 8 MiB를 초과합니다. 기간을 나누어 요약을 작성하세요.', 413);
  return storage;
}

// A publication is an immutable report snapshot and a durable external-write
// intent. Confluence v2 create-page has no atomic custom-property input, so an
// unconfirmed POST is reconciled only by an explicitly supplied page and exact
// storage/title/space comparison. Never search by title or automatically repost.
export function confluenceReports({ store, reports, client, notify = () => {} }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS confluence_publications (
    operation_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, cloud_id TEXT NOT NULL, space_id TEXT NOT NULL,
    title TEXT NOT NULL, storage TEXT NOT NULL, storage_digest TEXT NOT NULL, state TEXT NOT NULL,
    page_id TEXT, url TEXT, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS confluence_publication_target ON confluence_publications(report_id,cloud_id,space_id);
    CREATE UNIQUE INDEX IF NOT EXISTS confluence_publication_active_target ON confluence_publications(report_id,cloud_id,space_id)
      WHERE state IN ('preparing','sending','unknown','published');`);
  db.prepare("UPDATE confluence_publications SET state='failed',message='전송 전에 서비스가 종료되었습니다. 새 요청으로 게시할 수 있습니다.' WHERE state='preparing'").run();
  db.prepare("UPDATE confluence_publications SET state='unknown',message='게시 응답을 확인하지 못했습니다. Confluence 페이지 ID로 결과를 확인하세요.' WHERE state='sending'").run();
  const one = (sql, ...p) => db.prepare(sql).get(...p), exec = (sql, ...p) => db.prepare(sql).run(...p);
  const queues = new Map();
  function exclusive(key, fn) {
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn); queues.set(key, task);
    task.finally(() => { if (queues.get(key) === task) queues.delete(key); }).catch(() => {}); return task;
  }
  const raw = op => one('SELECT * FROM confluence_publications WHERE operation_id=?', op);
  function view(row) {
    if (!row) return null;
    const { storage, storage_digest, ...publicRow } = row; return publicRow;
  }
  function publications(reportId) {
    assert(reports.execution(reportId), '업무 요약을 찾을 수 없습니다.', 404);
    return db.prepare(`SELECT operation_id,report_id,cloud_id,space_id,title,state,page_id,url,message,created_at,updated_at
      FROM confluence_publications WHERE report_id=? ORDER BY rowid DESC`).all(reportId);
  }
  function finish(op, state, message = null, remote = {}) {
    exec('UPDATE confluence_publications SET state=?,message=?,page_id=COALESCE(?,page_id),url=COALESCE(?,url),updated_at=? WHERE operation_id=?',
      state, message ? redact(message).slice(0, 2000) : null, remote.page_id || null, remote.url || null, now(), op); notify();
    return view(raw(op));
  }
  function publish(reportId, input) {
    assert(input && Object.keys(input).every(k => ['operation_id', 'cloud_id', 'space_id'].includes(k))
      && typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id)
      && typeof input.cloud_id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(input.cloud_id)
      && typeof input.space_id === 'string' && /^\d{1,30}$/.test(input.space_id), 'Confluence 게시 요청과 공간을 확인하세요.');
    const { operation_id, cloud_id, space_id } = input;
    return exclusive(json([reportId, cloud_id, space_id]), async () => {
      const prior = raw(operation_id);
      if (prior) {
        assert(prior.report_id === reportId && prior.cloud_id === cloud_id && prior.space_id === space_id, '같은 게시 요청 식별자의 내용이 다릅니다.', 409);
        return { ...view(prior), repeated: true };
      }
      const current = one("SELECT * FROM confluence_publications WHERE report_id=? AND cloud_id=? AND space_id=? AND state IN ('preparing','sending','unknown','published')", reportId, cloud_id, space_id);
      if (current) return { ...view(current), repeated: true };
      const detail = reports.detail(reportId, { summary: true }), { report } = detail;
      assert(report.state === 'completed' && typeof report.title === 'string' && report.title.trim() && report.title.length <= 255
        && typeof report.body === 'string' && report.body.trim(), '완료된 로컬 요약만 게시할 수 있습니다.', 409);
      const storage = buildReportStorage(detail), time = now();
      exec('INSERT INTO confluence_publications VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)', operation_id, reportId, cloud_id, space_id,
        report.title, storage, digest(storage), 'preparing', time, time); notify();
      try {
        const remote = await client.createConfluencePage({ cloud_id, space_id, title: report.title, storage }, {
          beforeSend: () => { finish(operation_id, 'sending'); }
        });
        return finish(operation_id, 'published', null, remote);
      } catch (e) {
        const unknown = !e.not_sent && raw(operation_id).state === 'sending' && (e.code === 'unconfirmed' || e.status >= 500);
        finish(operation_id, unknown ? 'unknown' : 'failed', unknown
          ? '게시 응답을 확인하지 못했습니다. 자동으로 다시 게시하지 않습니다. Confluence에서 페이지 ID를 찾아 결과를 확인하세요.' : e.message);
        throw e;
      }
    });
  }
  function resolve(reportId, operationId, input) {
    assert(input && Object.keys(input).length === 1 && typeof input.page_id === 'string' && /^\d{1,30}$/.test(input.page_id), '확인할 Confluence 페이지 ID를 입력하세요.');
    const prior = raw(operationId); assert(prior && prior.report_id === reportId, '게시 기록을 찾을 수 없습니다.', 404);
    return exclusive(json([reportId, prior.cloud_id, prior.space_id]), async () => {
      const current = raw(operationId);
      if (current.state === 'published') {
        assert(current.page_id === input.page_id, '이미 연결된 Confluence 페이지가 다릅니다.', 409);
        return { ...view(current), repeated: true };
      }
      assert(current.state === 'unknown', '응답을 확인하지 못한 게시 기록만 페이지 ID로 확인할 수 있습니다.', 409);
      const { page, url } = await client.confluencePageForPublication(current.cloud_id, input.page_id);
      assert(page?.id === input.page_id && page.spaceId === current.space_id && page.status === 'current'
        && page.title === current.title && typeof page.body?.storage?.value === 'string' && digest(page.body.storage.value) === current.storage_digest,
      '공간·제목·본문이 원본 요약과 일치하지 않습니다. 게시 기록은 미확인으로 유지됩니다.', 409);
      return finish(operationId, 'published', '지정한 페이지의 공간·제목·본문이 저장한 게시 내용과 일치함을 확인했습니다.', { page_id: input.page_id, url });
    });
  }
  return { publications, publish, resolve };
}
