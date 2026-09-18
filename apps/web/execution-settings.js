export function executionSettingsUI({ api, esc, modal, toast }) {
  const $ = selector => document.querySelector(selector);
  let snapshot;
  const effortOptions = (selected, efforts) => `<option value="">유형 기본값 사용</option>${efforts.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}`;
  const defaults = backend => Object.entries(backend.defaults).map(([stage, value]) => `${stage}: ${value.model} / ${value.effort}`).join(' · ');
  function render(taskId) {
    const task = snapshot.tasks.find(value => value.id === taskId) || snapshot.tasks[0];
    modal(`<h2>작업 실행 설정</h2><p>새로 시작하는 작업에 적용할 지시문과 backend 설정입니다. 진행 중인 작업의 고정 설정은 바뀌지 않습니다.</p>
      <div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="execution-task">작업 유형</label><select id="execution-task">${snapshot.tasks.map(value => `<option value="${esc(value.id)}" ${value.id === task.id ? 'selected' : ''}>${esc(value.label)} · ${esc(value.id)}</option>`).join('')}</select>
      <label for="task-instruction">작업 지시문</label><textarea id="task-instruction" maxlength="12000">${esc(task.instruction)}</textarea>
      <label for="task-backend">기본 backend</label><select id="task-backend"><option value="codex" ${task.backend === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${task.backend === 'claude' ? 'selected' : ''}>Claude</option></select>
      <div class="backend-settings">
        ${['codex', 'claude'].map(engine => `<section><h3>${engine === 'codex' ? 'Codex' : 'Claude'}</h3>
          <label for="${engine}-model">Model override</label><input id="${engine}-model" value="${esc(task.backends[engine].model || '')}" placeholder="유형 기본값 사용">
          <label for="${engine}-effort">Effort override</label><select id="${engine}-effort">${effortOptions(task.backends[engine].effort, snapshot.efforts[engine])}</select>
          <p class="help">${esc(defaults(task.backends[engine]))}</p></section>`).join('')}
      </div>
      <p class="help">빈 model과 ‘유형 기본값 사용’은 단계별 기본 프로필을 유지합니다. override를 지정하면 이 작업의 생성·검토·수정 단계에 같은 값을 적용합니다.</p>
      <div class="dialog-actions"><button data-close>닫기</button><button id="reset-execution" class="secondary" ${task.overridden ? '' : 'disabled'}>기본값 복원</button><button id="save-execution" class="primary">저장</button></div>`);
    $('#execution-task').onchange = event => render(event.target.value);
    $('#save-execution').onclick = async () => {
      const button = $('#save-execution'); button.disabled = true;
      try {
        snapshot = await api(`/execution-settings/${encodeURIComponent(task.id)}`, { method: 'PUT', body: {
          revision: snapshot.revision, instruction: $('#task-instruction').value, backend: $('#task-backend').value,
          backends: Object.fromEntries(['codex', 'claude'].map(engine => [engine, {
            model: $(`#${engine}-model`).value.trim() || null, effort: $(`#${engine}-effort`).value || null
          }]))
        } });
        toast('작업 실행 설정을 저장했습니다.'); render(task.id);
      } catch (error) { $('#dialog-error').textContent = error.message; $('#dialog-error').hidden = false; button.disabled = false; }
    };
    $('#reset-execution').onclick = async () => {
      try {
        snapshot = await api(`/execution-settings/${encodeURIComponent(task.id)}`, { method: 'DELETE', body: { revision: snapshot.revision } });
        toast('유형 기본값으로 복원했습니다.'); render(task.id);
      } catch (error) { $('#dialog-error').textContent = error.message; $('#dialog-error').hidden = false; }
    };
  }
  async function showSettings() { snapshot = await api('/execution-settings'); render(snapshot.tasks[0]?.id); }
  return { showSettings };
}
