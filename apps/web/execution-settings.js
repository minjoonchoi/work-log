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
  const defaults = backend => Object.entries(backend.defaults).map(([stage, value]) => `${stage}: ${value.model} / ${value.effort}`).join(' · ');
  const modelCatalog = engine => snapshot.models?.[engine] || [];
  function capabilities(engine, settings, model) {
    const catalog = modelCatalog(engine);
    const models = model ? [catalog.find(value => value.id === model)] : [...new Set(Object.values(settings.defaults).map(value => value.model))].map(id => catalog.find(value => value.id === id));
    const known = models.length > 0 && models.every(Boolean);
    return { known, efforts: known ? models[0].efforts.filter(effort => models.every(value => value.efforts.includes(effort))) : [] };
  }
  function modelOptions(engine, settings) {
    const selected = settings.model || '';
    const fallback = [...new Set(Object.values(settings.defaults).map(value => value.model))].join(' · ');
    const known = modelCatalog(engine).some(model => model.id === selected);
    return `<option value="">유형 기본값 사용 · ${esc(fallback)}</option>${modelCatalog(engine).map(model => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.label === model.id ? model.id : `${model.label} · ${model.id}`)}</option>`).join('')}
      ${selected && !known ? `<option value="${esc(selected)}" data-legacy selected>${esc(selected)} · 기존 저장값 (목록에 없음)</option>` : ''}`;
  }
  function effortState(engine, settings, model, effort) {
    const support = capabilities(engine, settings, model);
    const legacy = !!effort && !support.efforts.includes(effort);
    const automatic = [...new Set(Object.values(settings.defaults).map(base => {
      const selected = modelCatalog(engine).find(value => value.id === (model || base.model));
      return selected?.efforts.includes(base.effort) ? base.effort : selected?.default_effort;
    }))];
    const automaticLabel = automatic.length === 1 ? automatic[0] : '단계별';
    const label = !support.known ? '기존 모델 기본값 유지' : !support.efforts.length ? 'effort 사용 안 함'
      : `${model ? '자동 선택' : '유형 기본값 사용'} · ${automaticLabel}`;
    const options = `<option value="">${label}</option>${support.efforts.map(value => `<option value="${esc(value)}" ${effort === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}
      ${legacy ? `<option value="${esc(effort)}" data-legacy selected>${esc(effort)} · 기존 저장값 (지원 확인 필요)</option>` : ''}`;
    const warning = !support.known ? '현재 지원 목록에 없는 저장된 모델입니다. 변경하려면 목록의 모델을 선택하세요. 기존 설정은 그대로 유지됩니다.'
      : legacy ? '저장된 effort는 현재 모델에서 지원하지 않습니다. 기존 설정을 유지하거나 지원되는 설정으로 변경하세요.' : '';
    return { options, warning, disabled: !support.known || (!support.efforts.length && !legacy) };
  }
  function backendEditor(engine, settings) {
    const effort = effortState(engine, settings, settings.model || '', settings.effort || '');
    return `<section><h3>${engine === 'codex' ? 'Codex' : 'Claude'}</h3>
      <label for="${engine}-model">Model override</label><select id="${engine}-model" aria-describedby="${engine}-selection-notice">${modelOptions(engine, settings)}</select>
      <label for="${engine}-effort">Effort override</label><select id="${engine}-effort" aria-describedby="${engine}-selection-notice" ${effort.disabled ? 'disabled' : ''}>${effort.options}</select>
      <p id="${engine}-selection-notice" class="help model-selection-notice" role="status" ${effort.warning ? '' : 'hidden'}>${esc(effort.warning)}</p>
      <p class="help">유형 기본값: ${esc(defaults(settings))}</p></section>`;
  }
  const categories = { product: '제품 · PO', project: '프로젝트 · PM', design: '공통 설계', frontend: '프런트엔드', backend: '백엔드', engineering: '개발 공통', knowledge: '조사·문서', system: '시스템 작업' };
  const option = (task, selected) => `<option value="${esc(task.id)}" ${task.id === selected ? 'selected' : ''}>${esc(task.label)} · ${esc(task.id)}</option>`;
  const taskOptions = selected => {
    const groups = Object.entries(categories).map(([category, label]) => {
      const tasks = snapshot.tasks.filter(task => task.source !== 'user' && task.category === category);
      return tasks.length ? `<optgroup label="${esc(label)}">${tasks.map(task => option(task, selected)).join('')}</optgroup>` : '';
    }).join('');
    const custom = snapshot.tasks.filter(task => task.source === 'user');
    return groups + (custom.length ? `<optgroup label="사용자 작업">${custom.map(task => option(task, selected)).join('')}</optgroup>` : '');
  };
  const boundaryDetails = boundary => !boundary ? '' : `<section id="task-boundary" aria-label="작업 책임 경계">
    <p><strong>담당 결과</strong><br>${esc(boundary.owns)}<br><small>산출물: ${esc(boundary.deliverable)}</small></p>
    <p><strong>제외 범위</strong><br>${boundary.excludes.map(esc).join(' · ')}</p>
    <details><summary>필요 자료와 완료 기준</summary><p><strong>필요 자료</strong><br>${boundary.inputs.map(esc).join(' · ')}</p><p><strong>완료 기준</strong><br>${boundary.acceptance.map(esc).join('<br>')}</p></details>
    <p class="help">이 책임 경계는 지시문을 편집해도 유지됩니다.</p>
  </section>`;
  const editor = task => `<section class="instruction-editor" aria-label="Markdown 지시문">
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
        ${['codex', 'claude'].map(engine => backendEditor(engine, task.backends[engine])).join('')}
      </div>
      <p class="help">모델과 effort는 지원되는 조합만 선택할 수 있습니다. effort의 ‘자동 선택’은 유형의 단계별 기본값을 우선 사용하고, 선택한 모델이 그 값을 지원하지 않을 때만 모델 기본값을 사용합니다. effort 미지원 모델에는 값을 적용하지 않습니다. 두 backend의 설정은 각각 유지됩니다.</p>`;
  const metadata = task => `<section class="custom-task-metadata" aria-label="사용자 작업 정보">
      <label for="custom-task-label">작업 이름</label><input id="custom-task-label" value="${esc(task.label || '')}" maxlength="120" required>
      <label for="custom-task-description">작업 목적</label><textarea id="custom-task-description" maxlength="2000" required>${esc(task.description || '')}</textarea>
      <label for="custom-task-terms">선택 키워드</label><textarea id="custom-task-terms" aria-describedby="custom-task-terms-help" required>${esc((task.routing_terms || []).join(', '))}</textarea>
      <p id="custom-task-terms-help" class="help">이 작업을 요청할 때 쓸 구체적인 표현을 쉼표나 줄바꿈으로 구분해 1~20개 입력하세요. 각 표현은 80자 이내로 중복 없이 입력합니다. 다른 작업과 구별되는 표현을 사용하면 선택이 쉬워집니다.</p>
    </section>`;
  const errorMarkup = '<div id="dialog-error" class="error" role="alert" tabindex="-1" hidden></div>';
  const inherited = template => `<p class="custom-task-template"><strong>기반 작업 유형</strong><br>${esc(template.label)} · ${esc(template.id)}</p>
    <p class="help">기반 유형의 결과물 형식과 검토·수정 절차, 책임 경계를 그대로 사용합니다. 등록 후에는 기반 유형을 바꿀 수 없습니다.</p>`;
  function bindEditor(task) {
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
    for (const engine of ['codex', 'claude']) {
      const model = $(`#${engine}-model`), effort = $(`#${engine}-effort`), notice = $(`#${engine}-selection-notice`);
      const updateEffort = message => {
        const state = effortState(engine, task.backends[engine], model.value, effort.value);
        effort.innerHTML = state.options; effort.disabled = state.disabled;
        notice.textContent = state.warning || message || ''; notice.hidden = !notice.textContent;
      };
      model.onchange = () => {
        const support = capabilities(engine, task.backends[engine], model.value);
        const invalid = effort.value && !support.efforts.includes(effort.value);
        if (invalid) effort.value = '';
        model.querySelectorAll('option[data-legacy]').forEach(option => { if (!option.selected) option.remove(); });
        updateEffort(invalid ? support.efforts.length ? '선택한 모델이 지원하지 않는 effort를 기본값으로 바꿨습니다.' : '선택한 모델은 effort를 지원하지 않아 설정을 해제했습니다.' : '');
      };
      effort.onchange = () => updateEffort();
    }
  }
  const executionValues = () => ({
    revision: snapshot.revision, instruction: $('#task-instruction').value, backend: $('#task-backend').value,
    backends: Object.fromEntries(['codex', 'claude'].map(engine => [engine, {
      model: $(`#${engine}-model`).value.trim() || null, effort: $(`#${engine}-effort`).value || null
    }]))
  });
  const metadataValues = () => ({
    label: $('#custom-task-label').value.trim(), description: $('#custom-task-description').value.trim(),
    routing_terms: $('#custom-task-terms').value.split(/[,\n\r]+/).map(value => value.trim()).filter(Boolean)
  });
  async function mutate(action) {
    const controls = [...document.querySelectorAll('#modal-content button, #modal-content select, #modal-content input, #modal-content textarea')];
    const enabled = controls.filter(control => !control.disabled);
    enabled.forEach(control => { control.disabled = true; });
    const error = $('#dialog-error'); error.hidden = true;
    try { await action(); }
    catch (failure) {
      error.textContent = failure.message; error.hidden = false; error.focus();
    } finally { enabled.forEach(control => { control.disabled = false; }); }
  }
  function render(taskId) {
    const task = snapshot.tasks.find(value => value.id === taskId) || snapshot.tasks[0];
    const custom = task.source === 'user';
    const template = custom && snapshot.tasks.find(value => value.id === task.template_id);
    modal(`<h2>작업 실행 설정</h2><p>새로 시작하는 작업에 적용할 지시문과 backend 설정입니다. 진행 중인 작업의 고정 설정은 바뀌지 않습니다.</p>
      ${errorMarkup}
      <div class="execution-task-toolbar"><label for="execution-task">작업 유형</label><button id="add-custom-task" class="secondary">사용자 작업 등록</button></div>
      <select id="execution-task">${taskOptions(task.id)}</select>
      ${custom ? `<p class="execution-task-source"><span>사용자 작업</span><small>${esc(task.id)}</small></p>${metadata(task)}${inherited(template || { id: task.template_id, label: task.template_id })}` : ''}
      ${boundaryDetails(task.boundary)}${editor(task)}
      ${custom ? '<p class="help">기본값 복원은 지시문과 backend 설정을 복원합니다. 등록한 작업 유형과 이름·목적·키워드는 유지됩니다.</p>' : ''}
      <div class="dialog-actions execution-settings-actions"><button data-close>닫기</button>${custom ? '<button id="delete-custom-task" class="custom-task-delete">작업 등록 삭제</button>' : ''}<button id="reset-execution" class="secondary" ${task.overridden ? '' : 'disabled'}>기본값 복원</button><button id="save-execution" class="primary">저장</button></div>
      ${custom ? `<section id="custom-task-delete-confirmation" class="custom-task-delete-confirmation" aria-label="작업 등록 삭제 확인" hidden><p><strong>${esc(task.label)}</strong> 작업 등록을 삭제할까요? 이후 새 작업에서 선택할 수 없으며, 기존 실행 기록은 유지됩니다.</p><div class="dialog-actions"><button id="cancel-custom-task-delete">취소</button><button id="confirm-custom-task-delete" class="custom-task-delete">등록 삭제</button></div></section>` : ''}`);
    $('#execution-task').onchange = event => render(event.target.value);
    $('#add-custom-task').onclick = () => renderCreate(task.id);
    bindEditor(task);
    $('#save-execution').onclick = () => mutate(async () => {
      snapshot = await api(`/execution-settings/${encodeURIComponent(task.id)}`, { method: 'PUT', body: {
        ...executionValues(), ...(custom ? metadataValues() : {})
      } });
      toast('작업 실행 설정을 저장했습니다.'); render(task.id);
    });
    $('#reset-execution').onclick = () => mutate(async () => {
      snapshot = await api(`/execution-settings/${encodeURIComponent(task.id)}`, { method: 'DELETE', body: { revision: snapshot.revision } });
      toast('유형 기본값으로 복원했습니다.'); render(task.id);
    });
    if (custom) {
      $('#delete-custom-task').onclick = () => {
        $('#custom-task-delete-confirmation').hidden = false;
        $('#cancel-custom-task-delete').focus();
      };
      $('#cancel-custom-task-delete').onclick = () => {
        $('#custom-task-delete-confirmation').hidden = true;
        $('#delete-custom-task').focus();
      };
      $('#confirm-custom-task-delete').onclick = () => mutate(async () => {
        snapshot = await api(`/execution-settings/custom-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE', body: { revision: snapshot.revision } });
        toast('사용자 작업 등록을 삭제했습니다.'); render(task.template_id);
      });
    }
  }
  function renderCreate(previousId, templateId = 'document.create', draft = {}) {
    const templates = (snapshot.templates || []).map(id => snapshot.tasks.find(task => task.id === id)).filter(Boolean);
    const template = templates.find(task => task.id === templateId) || templates[0];
    modal(`<h2>사용자 작업 등록</h2><p>기존 작업을 기반으로 자주 사용하는 작업 유형을 등록하세요. 등록한 유형은 설정을 다시 열거나 앱을 다시 시작해도 유지됩니다.</p>
      ${errorMarkup}
      <label for="custom-task-template">기반 작업 유형</label><select id="custom-task-template">${templates.map(task => option(task, template?.id)).join('')}</select>
      <p class="help">기반 유형을 바꾸면 지시문과 backend 입력을 해당 유형의 현재 설정으로 바꿉니다.</p>
      ${template ? `${inherited(template)}${boundaryDetails(template.boundary)}${metadata(draft)}${editor(template)}` : '<p class="help">등록에 사용할 수 있는 기반 작업 유형이 없습니다.</p>'}
      <div class="dialog-actions"><button id="cancel-custom-task">취소</button><button id="create-custom-task" class="primary" ${template ? '' : 'disabled'}>등록</button></div>`);
    $('#cancel-custom-task').onclick = () => render(previousId);
    if (!template) return;
    $('#custom-task-template').onchange = event => renderCreate(previousId, event.target.value, metadataValues());
    bindEditor(template);
    $('#create-custom-task').onclick = () => mutate(async () => {
      snapshot = await api('/execution-settings/custom-tasks', { method: 'POST', body: {
        ...executionValues(), ...metadataValues(), template_id: template.id
      } });
      toast('사용자 작업을 등록했습니다.'); render(snapshot.created_task_id);
    });
  }
  async function showSettings() { snapshot = await api('/execution-settings'); render(snapshot.tasks[0]?.id); }
  return { showSettings };
}
