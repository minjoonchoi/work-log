export function executionSettingsUI({ api, esc, modal, toast }) {
  const $ = selector => document.querySelector(selector);
  let snapshot;
  // A bounded renderer: every source character is escaped before our own tags
  // are added. Raw HTML, links and images stay text and cannot execute or load.
  function markdown(source) {
    const inline = text => {
      const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
      let html = '', position = 0;
      for (const match of text.matchAll(tokens)) {
        html += esc(text.slice(position, match.index));
        const tag = match[1] ? 'code' : match[2] ? 'strong' : 'em';
        html += `<${tag}>${esc(match[1] || match[2] || match[3])}</${tag}>`;
        position = match.index + match[0].length;
      }
      return html + esc(text.slice(position));
    };
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    let html = '', paragraph = [], list = [], listTag = '', code = null;
    const flush = () => {
      if (paragraph.length) { html += `<p>${paragraph.map(inline).join('<br>')}</p>`; paragraph = []; }
      if (list.length) { html += `<${listTag}>${list.map(line => `<li>${inline(line)}</li>`).join('')}</${listTag}>`; list = []; listTag = ''; }
    };
    for (const line of lines) {
      if (/^```(?:[\w+-]*)?\s*$/.test(line)) {
        flush();
        if (code === null) code = [];
        else { html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = null; }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      if (!line.trim()) { flush(); continue; }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { flush(); const level = Math.min(6, heading[1].length + 2); html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
      const bullet = line.match(/^\s*[-+*]\s+(.+)$/), number = line.match(/^\s*\d+\.\s+(.+)$/), item = bullet || number;
      if (item) {
        const tag = bullet ? 'ul' : 'ol';
        if (paragraph.length || (listTag && listTag !== tag)) flush();
        listTag = tag; list.push(item[1]);
      } else { if (list.length) flush(); paragraph.push(line); }
    }
    flush(); if (code !== null) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
    return html || '<p class="help">작성한 지시문이 여기에 표시됩니다.</p>';
  }
  const effortOptions = (selected, efforts) => `<option value="">유형 기본값 사용</option>${efforts.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}`;
  const defaults = backend => Object.entries(backend.defaults).map(([stage, value]) => `${stage}: ${value.model} / ${value.effort}`).join(' · ');
  const categories = { product: '제품 · PO', project: '프로젝트 · PM', design: '공통 설계', frontend: '프런트엔드', backend: '백엔드', engineering: '개발 공통', knowledge: '조사·문서', system: '시스템 작업' };
  const taskOptions = selected => Object.entries(categories).map(([category, label]) => {
    const tasks = snapshot.tasks.filter(task => task.category === category);
    return tasks.length ? `<optgroup label="${esc(label)}">${tasks.map(task => `<option value="${esc(task.id)}" ${task.id === selected ? 'selected' : ''}>${esc(task.label)} · ${esc(task.id)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const boundaryDetails = boundary => !boundary ? '' : `<section id="task-boundary" aria-label="작업 책임 경계">
    <p><strong>담당 결과</strong><br>${esc(boundary.owns)}<br><small>산출물: ${esc(boundary.deliverable)}</small></p>
    <p><strong>제외 범위</strong><br>${boundary.excludes.map(esc).join(' · ')}</p>
    <details><summary>필요 자료와 완료 기준</summary><p><strong>필요 자료</strong><br>${boundary.inputs.map(esc).join(' · ')}</p><p><strong>완료 기준</strong><br>${boundary.acceptance.map(esc).join('<br>')}</p></details>
    <p class="help">이 책임 경계는 지시문을 편집해도 유지됩니다.</p>
  </section>`;
  function render(taskId) {
    const task = snapshot.tasks.find(value => value.id === taskId) || snapshot.tasks[0];
    modal(`<h2>작업 실행 설정</h2><p>새로 시작하는 작업에 적용할 지시문과 backend 설정입니다. 진행 중인 작업의 고정 설정은 바뀌지 않습니다.</p>
      <div id="dialog-error" class="error" role="alert" hidden></div>
      <label for="execution-task">작업 유형</label><select id="execution-task">${taskOptions(task.id)}</select>
      ${boundaryDetails(task.boundary)}
      <section class="instruction-editor" aria-label="Markdown 지시문">
        <div class="instruction-editor-heading"><label for="task-instruction">작업 지시문</label><span>Markdown</span></div>
        <div class="instruction-tabs" role="tablist" aria-label="지시문 보기 방식">
          <button type="button" id="instruction-preview-tab" role="tab" aria-selected="true" aria-controls="instruction-preview">미리보기</button>
          <button type="button" id="instruction-edit-tab" role="tab" aria-selected="false" aria-controls="instruction-source" tabindex="-1">원문 편집</button>
        </div>
        <div id="instruction-preview" class="instruction-preview" role="tabpanel" aria-labelledby="instruction-preview-tab">${markdown(task.instruction)}</div>
        <div id="instruction-source" role="tabpanel" aria-labelledby="instruction-edit-tab" hidden><textarea id="task-instruction" maxlength="12000" spellcheck="false" aria-describedby="instruction-help">${esc(task.instruction)}</textarea></div>
        <p id="instruction-help" class="help">제목, 목록, 강조, 코드 블록을 미리 볼 수 있습니다. HTML·링크·이미지는 텍스트로 표시합니다. 원문을 편집한 뒤 저장하면 새 작업부터 적용됩니다.</p>
      </section>
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
    const instructionTabs = [$('#instruction-preview-tab'), $('#instruction-edit-tab')];
    function showInstruction(index, focus = false) {
      const edit = index === 1;
      if (!edit) $('#instruction-preview').innerHTML = markdown($('#task-instruction').value);
      $('#instruction-preview').hidden = edit; $('#instruction-source').hidden = !edit;
      instructionTabs.forEach((tab, n) => { tab.setAttribute('aria-selected', String(n === index)); tab.tabIndex = n === index ? 0 : -1; });
      if (focus) instructionTabs[index].focus();
    }
    instructionTabs.forEach((tab, index) => {
      tab.onclick = () => showInstruction(index);
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); showInstruction(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true);
      };
    });
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
