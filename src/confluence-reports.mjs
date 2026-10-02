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
    CREATE INDEX IF NOT EXISTS confluence_publication_target ON confluence_publications(report_id,cloud_id,space_id);`);
  const columns = db.prepare('PRAGMA table_info(confluence_publications)').all().map(row => row.name);
  for (const name of ['parent_id', 'parent_type']) if (!columns.includes(name)) db.exec(`ALTER TABLE confluence_publications ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.exec(`DROP INDEX IF EXISTS confluence_publication_active_target;
    CREATE UNIQUE INDEX IF NOT EXISTS confluence_publication_active_location ON confluence_publications(report_id,cloud_id,space_id,parent_id)
      WHERE state IN ('preparing','sending','unknown','published');`);
  db.prepare("UPDATE confluence_publications SET state='failed',message='전송 전에 서비스가 종료되었습니다. 새 요청으로 게시할 수 있습니다.' WHERE state='preparing'").run();
  db.prepare("UPDATE confluence_publications SET state='unknown',message='게시 응답을 확인하지 못했습니다. Confluence 페이지 ID로 결과를 확인하세요.' WHERE state='sending'").run();
  const one = (sql, ...p) => db.prepare(sql).get(...p), exec = (sql, ...p) => db.prepare(sql).run(...p);
  db.exec(`CREATE TABLE IF NOT EXISTS confluence_report_folders (
    cloud_id TEXT NOT NULL, space_id TEXT NOT NULL, folder_id TEXT, state TEXT NOT NULL,
    PRIMARY KEY(cloud_id,space_id));`);
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
    return db.prepare(`SELECT operation_id,report_id,cloud_id,space_id,title,state,page_id,url,message,created_at,updated_at,parent_id,parent_type
      FROM confluence_publications WHERE report_id=? ORDER BY rowid DESC`).all(reportId);
  }
  function finish(op, state, message = null, remote = {}) {
    exec('UPDATE confluence_publications SET state=?,message=?,page_id=COALESCE(?,page_id),url=COALESCE(?,url),updated_at=? WHERE operation_id=?',
      state, message ? redact(message).slice(0, 2000) : null, remote.page_id || null, remote.url || null, now(), op); notify();
    return view(raw(op));
  }
  async function reportFolder(cloud, space) {
    let saved = one('SELECT * FROM confluence_report_folders WHERE cloud_id=? AND space_id=?', cloud, space.id);
    if (saved?.folder_id) {
      let row;
      try { row = await client.request(`/ex/confluence/${cloud}/wiki/api/v2/folders/${saved.folder_id}`); }
      catch (error) {
        if (error.status !== 404) throw error;
        exec('DELETE FROM confluence_report_folders WHERE cloud_id=? AND space_id=?', cloud, space.id); saved = null;
      }
      if (saved) {
        assert(row?.id === saved.folder_id && row.spaceId === space.id && row.status === 'current' && row.title === '업무 요약',
          '기존 업무 요약 폴더가 이동·변경되었거나 삭제되었습니다. Confluence에서 폴더를 확인하세요.', 409);
        return saved.folder_id;
      }
    }
    let cursor = null, folder = null;
    const seen = new Set();
    do {
      assert(!seen.has(cursor) && seen.size < 100, '업무 요약 폴더 검색을 완료하지 못했습니다. 다시 시도하세요.', 502); seen.add(cursor);
      const result = await client.confluenceTargets({ cloud_id: cloud, space_id: space.id, query: '업무 요약', cursor });
      for (const row of result.items.filter(row => row.type === 'folder' && row.title === '업무 요약')) {
        assert(!folder || folder === row.id, '개인 공간에 업무 요약 폴더가 여러 개 있습니다. Confluence에서 하나로 정리한 뒤 다시 게시하세요.', 409);
        folder = row.id;
      }
      cursor = result.next_cursor;
    } while (cursor);
    if (!folder) {
      assert(saved?.state !== 'unknown', '업무 요약 폴더 생성 결과가 미확인입니다. Confluence에서 생성 여부를 확인한 뒤 다시 시도하세요. 중복 폴더는 만들지 않습니다.', 409);
      try {
        folder = await client.createReportFolder(cloud, space.id, () => {
          exec("INSERT INTO confluence_report_folders(cloud_id,space_id,state) VALUES(?,?,'unknown') ON CONFLICT(cloud_id,space_id) DO UPDATE SET state='unknown'", cloud, space.id);
        });
      } catch (error) {
        if (error.not_sent || (error.status >= 400 && error.status < 500)) exec("DELETE FROM confluence_report_folders WHERE cloud_id=? AND space_id=? AND state='unknown'", cloud, space.id);
        error.message = `업무 요약 폴더 생성 실패: ${error.message}`;
        throw error;
      }
    }
    exec("INSERT INTO confluence_report_folders(cloud_id,space_id,folder_id,state) VALUES(?,?,?,'ready') ON CONFLICT(cloud_id,space_id) DO UPDATE SET folder_id=excluded.folder_id,state='ready'", cloud, space.id, folder);
    return folder;
  }
  function publish(reportId, input) {
    assert(input && Object.keys(input).every(k => ['operation_id', 'cloud_id'].includes(k))
      && typeof input.operation_id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.operation_id)
      && typeof input.cloud_id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(input.cloud_id), '개인 공간 게시 요청을 확인하세요. 공간·상위 폴더는 직접 지정할 수 없습니다.');
    const { operation_id, cloud_id } = input;
    // Serialize folder discovery/creation across all reports for this site.
    return exclusive(json(['personal-publication', cloud_id]), async () => {
      const prior = raw(operation_id);
      if (prior) {
        assert(prior.report_id === reportId && prior.cloud_id === cloud_id, '같은 게시 요청 식별자의 내용이 다릅니다.', 409);
        return { ...view(prior), repeated: true };
      }
      const detail = reports.detail(reportId, { summary: true }), { report } = detail;
      assert(report.state === 'completed' && typeof report.title === 'string' && report.title.trim() && report.title.length <= 255
        && typeof report.body === 'string' && report.body.trim(), '완료된 로컬 요약만 게시할 수 있습니다.', 409);
      const storage = buildReportStorage(detail), time = now();
      const space = await client.personalPublicationSpace(cloud_id), space_id = space.id;
      const existing = one("SELECT * FROM confluence_publications WHERE report_id=? AND cloud_id=? AND space_id=? AND parent_type='folder' AND parent_id=(SELECT folder_id FROM confluence_report_folders WHERE cloud_id=? AND space_id=?) AND state IN ('preparing','sending','unknown','published')", reportId, cloud_id, space_id, cloud_id, space_id);
      if (existing) return { ...view(existing), repeated: true };
      const parent_id = await reportFolder(cloud_id, space), parent_type = 'folder';
      const current = one("SELECT * FROM confluence_publications WHERE report_id=? AND cloud_id=? AND space_id=? AND parent_id=? AND state IN ('preparing','sending','unknown','published')", reportId, cloud_id, space_id, parent_id);
      if (current) return { ...view(current), repeated: true };
      exec('INSERT INTO confluence_publications(operation_id,report_id,cloud_id,space_id,title,storage,storage_digest,state,created_at,updated_at,parent_id,parent_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', operation_id, reportId, cloud_id, space_id,
        report.title, storage, digest(storage), 'preparing', time, time, parent_id, parent_type); notify();
      try {
        const remote = await client.createConfluencePage({ cloud_id, space_id, title: report.title, storage, parent_id, parent_type }, {
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
    return exclusive(json([reportId, prior.cloud_id, prior.space_id, prior.parent_id]), async () => {
      const current = raw(operationId);
      if (current.state === 'published') {
        assert(current.page_id === input.page_id, '이미 연결된 Confluence 페이지가 다릅니다.', 409);
        return { ...view(current), repeated: true };
      }
      assert(current.state === 'unknown', '응답을 확인하지 못한 게시 기록만 페이지 ID로 확인할 수 있습니다.', 409);
      const { page, url } = await client.confluencePageForPublication(current.cloud_id, input.page_id);
      assert(page?.id === input.page_id && page.spaceId === current.space_id && page.status === 'current'
        && (!current.parent_id || page.parentId === current.parent_id) && page.title === current.title && typeof page.body?.storage?.value === 'string' && digest(page.body.storage.value) === current.storage_digest,
      '공간·제목·본문이 원본 요약과 일치하지 않습니다. 게시 기록은 미확인으로 유지됩니다.', 409);
      return finish(operationId, 'published', '지정한 페이지의 공간·제목·본문이 저장한 게시 내용과 일치함을 확인했습니다.', { page_id: input.page_id, url });
    });
  }
  return { publications, publish, resolve };
}
