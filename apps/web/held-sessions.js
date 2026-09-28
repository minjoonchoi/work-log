export async function showHeldSessions({ api, esc, modal, onBack }) {
  modal('<h2>분류 보류 기록</h2><p>자동 타이틀 요청 형식이지만 출처를 확인할 수 없어 업무 등록을 보류했습니다. 실제 사용자 요청만 업무로 등록하세요.</p><div id="held-list"></div><p id="held-error" role="alert"></p><div class="dialog-actions"><button id="held-more" hidden>더 보기</button><button id="held-back">연결 설정으로 돌아가기</button></div>');
  const root = document.querySelector('#held-list'), error = document.querySelector('#held-error');
  const more = document.querySelector('#held-more'), back = document.querySelector('#held-back');
  let cursor = null, busy = false;
  back.onclick = onBack;
  async function load() {
    if (busy) return;
    busy = true; more.disabled = true; error.textContent = '';
    try {
      const result = await api('/held-sessions' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''));
      if (!root.isConnected) return;
      if (!cursor && !result.records.length) root.innerHTML = '<p>분류 보류 기록이 없습니다.</p>';
      for (const row of result.records) {
        const article = document.createElement('article');
        article.className = 'agent-connection-card';
        article.innerHTML = `<h3>자동 타이틀 요청 의심</h3><p>${esc(row.engine)} · ${esc(new Date(row.created_at).toLocaleString())} · 기록 ${row.event_count}개</p><small>${esc(row.source_id)}</small><details><summary>원본 기록 확인</summary><div class="held-preview"></div></details><p class="help">업무로 등록하면 보존된 입출력과 이후 대화를 같은 업무에 연결합니다.</p><button class="primary" data-promote>업무로 등록</button>`;
        const details = article.querySelector('details'), preview = article.querySelector('.held-preview');
        let loaded = false;
        details.ontoggle = async () => {
          if (!details.open || loaded) return;
          try {
            const data = await api('/held-sessions/' + encodeURIComponent(row.id));
            preview.innerHTML = data.events.map(e => `<details><summary>${esc(e.kind)} · ${esc(e.event_at)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(e.text || '(본문 없음)')}</pre></details>`).join('') +
              (data.event_count > 100 ? '<p>최초 100개 기록을 표시합니다. 등록 시 전체 이력이 복원됩니다.</p>' : '');
            loaded = true;
          } catch (e) { error.textContent = e.message; }
        };
        const button = article.querySelector('[data-promote]');
        button.onclick = async () => {
          button.disabled = true; error.textContent = '';
          try {
            await api('/held-sessions/' + encodeURIComponent(row.id) + '/promote', { method: 'POST', body: {} });
            article.innerHTML = '<p role="status">업무로 등록했습니다. 업무 목록에서 확인할 수 있습니다.</p>';
          } catch (e) { error.textContent = e.message; button.disabled = false; }
        };
        root.append(article);
      }
      cursor = result.next_cursor; more.hidden = !cursor;
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; more.disabled = false; }
  }
  more.onclick = load;
  await load();
}
