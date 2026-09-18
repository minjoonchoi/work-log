import { assert } from './shared.mjs';

// Writing and Jira synchronization have separate responsibilities and persisted states.
export function integrationCoordinator({ integrations, client, notify, writings, enabled = true }) {
  let busy = false;
  const checkedUnknown = new Set();
  async function tick() {
    if (busy) return; busy = true;
    try {
      await writings.tick();
      if (!enabled) return;
      const sessions = integrations.closedSessions();
      if (integrations.invalidateOpenWorklogs(new Set(sessions.map(s => s.id)))) notify();
      for (const session of sessions) {
        const summary = integrations.summary(session.id);
        if (summary?.state !== 'completed' || summary.accepted_digest !== session.source_digest) continue;
        const prior = integrations.worklog(session.id), links = integrations.links(session.work_item_id).filter(l => l.state === 'linked');
        const link = prior ? links.find(l => l.operation_id === prior.issue_operation_id)
          : links.find(l => l.work_item_id === session.original_work_item_id) || links.find(l => l.work_item_id === session.work_item_id) || (links.length === 1 ? links[0] : null);
        if (!link || prior?.state === 'needs_review') continue;
        const row = integrations.beginWorklog(session, link, summary.text);
        if (['synced', 'failed', 'sending'].includes(row.state)) continue;
        if (session.seconds <= 0) { integrations.finishWorklog(session.id, 'failed', null, '시작부터 마지막 출력까지의 양수 작업 시간을 확인할 수 없습니다.'); notify(); continue; }
        if (row.state === 'unknown') {
          if (checkedUnknown.has(row.operation_id)) continue;
          checkedUnknown.add(row.operation_id);
          try {
            const found = await client.findWorklog(link.issue, row.operation_id);
            if (found) {
              const marker = found.properties.find(p => p.key === 'work-log').value;
              integrations.finishWorklog(session.id, marker.source_digest === row.source_digest ? 'synced' : 'pending', found.id);
            } else integrations.finishWorklog(session.id, 'unknown', null, '전송 결과가 불명확합니다. Jira 확인 전에는 중복 생성하지 않습니다.');
          } catch (e) { integrations.finishWorklog(session.id, 'unknown', null, e.message); }
          notify(); continue;
        }
        if (!(await client.status()).connected) continue;
        integrations.finishWorklog(session.id, 'sending'); notify();
        try {
          const result = await client.writeWorklog(link.issue, row);
          integrations.finishWorklog(session.id, 'synced', result.id);
        } catch (e) {
          integrations.finishWorklog(session.id, !e.not_sent && (e.code === 'unconfirmed' || e.status >= 500) ? 'unknown' : 'failed', null, e.message);
        }
        notify();
      }
    } finally { busy = false; }
  }
  return { tick, retry: sid => {
    const row = integrations.worklog(sid); assert(row, '동기화할 업무 로그가 없습니다.', 404);
    checkedUnknown.delete(row.operation_id); integrations.retryWorklog(sid); notify();
  } };
}
