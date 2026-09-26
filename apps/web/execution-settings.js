export function executionSettingsUI({ api, esc, modal, toast, showConnections }) {
  const $ = selector => document.querySelector(selector);
  let snapshot, activeDraft, currentGroup = 'worklog';
  const lastTask = new Map();
  const worklogTasks = new Set(['session.summarize', 'text.rewrite', 'task.type.draft', 'work.report.create', 'work-item.result.summarize']);
  const groupOf = task => task.source === 'user' ? 'harness' : task.management_group || (worklogTasks.has(task.id) ? 'worklog' : 'harness');
  const installed = task => groupOf(task) === 'worklog' || task.installed !== false;
  const editable = task => task.source === 'user' || installed(task);
  const draftTerminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']);
  function cancelRemoteDraft(work) {
    if (!work.id || work.settled) return Promise.resolve();
    return work.cancelPromise ||= api(`/execution-settings/custom-task-drafts/${encodeURIComponent(work.id)}/cancel`, { method: 'POST', body: {} });
  }
  function abandonDraft() {
    const work = activeDraft; activeDraft = null;
    if (!work) return;
    clearTimeout(work.timer);
    cancelRemoteDraft(work).catch(() => {});
  }
  window.addEventListener('worklog:modal-open', abandonDraft);
  $('#modal')?.addEventListener('close', abandonDraft);
  window.addEventListener('pagehide', abandonDraft);
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
  const option = (task, selected) => `<option value="${esc(task.id)}" ${task.id === selected ? 'selected' : ''}>${esc(task.label)} · ${esc(task.id)}${installed(task) ? '' : task.source === 'user' ? ' · 기반 패키지 미설치' : ' · 미설치'}</option>`;
  const taskOptions = selected => {
    const groups = Object.entries(categories).map(([category, label]) => {
      const tasks = snapshot.tasks.filter(task => task.source !== 'user' && groupOf(task) === currentGroup && task.category === category);
      return tasks.length ? `<optgroup label="${esc(label)}">${tasks.map(task => option(task, selected)).join('')}</optgroup>` : '';
    }).join('');
    const custom = snapshot.tasks.filter(task => task.source === 'user' && currentGroup === 'harness');
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
  function render(taskId, group = currentGroup) {
    const requested = snapshot.tasks.find(value => value.id === taskId);
    currentGroup = requested ? groupOf(requested) : group;
    const tasks = snapshot.tasks.filter(value => groupOf(value) === currentGroup);
    const task = requested || tasks.find(value => value.id === lastTask.get(currentGroup)) || tasks.find(installed) || tasks[0];
    if (task) lastTask.set(currentGroup, task.id);
    const custom = task?.source === 'user', inactive = task && !editable(task);
    const template = custom && snapshot.tasks.find(value => value.id === task.template_id);
    modal(`<h2>작업 실행 설정</h2><p>새로 시작하는 작업에 적용할 지시문과 backend 설정입니다. 진행 중인 작업의 고정 설정은 바뀌지 않습니다.</p>
      ${errorMarkup}
      <div class="execution-management-tabs" role="tablist" aria-label="작업 관리 영역">${[['worklog', 'WorkLog 자동 생성'], ['harness', '하네스 작업']].map(([group, label]) => `<button type="button" id="execution-group-${group}" role="tab" aria-selected="${currentGroup === group}" aria-controls="execution-management-panel" tabindex="${currentGroup === group ? 0 : -1}">${label}</button>`).join('')}</div>
      <section id="execution-management-panel" role="tabpanel" aria-labelledby="execution-group-${currentGroup}">
      <p class="execution-group-description">${currentGroup === 'worklog' ? '제목·설명, 세션 요약, 업무 요약 등 앱의 자동 생성 기능입니다. 직무 패키지나 에이전트 위임 연결 없이 사용할 수 있습니다.' : '에이전트에서 요청을 위임할 때 사용하는 작업 유형입니다. 직무 패키지는 연결 설정에서 설치·제거하고, 사용자 등록 유형은 계속 보존합니다.'}</p>
      <div class="execution-task-toolbar"><label for="execution-task">작업 유형</label>${currentGroup === 'harness' ? `<div><button id="manage-harness-packages" class="secondary">직무 패키지 관리</button><button id="add-custom-task" class="secondary" ${(snapshot.templates || []).length ? '' : 'disabled'}>사용자 작업 등록</button></div>` : ''}</div>
      ${currentGroup === 'harness' && !(snapshot.templates || []).length ? '<p class="help">새 사용자 작업을 등록하려면 기반으로 사용할 직무 패키지를 먼저 설치하세요. 기존 사용자 작업은 계속 편집할 수 있습니다.</p>' : ''}
      <select id="execution-task" ${task ? '' : 'disabled'}>${taskOptions(task?.id)}</select>
      ${task ? `
      ${inactive ? '<p class="connection-note" id="execution-package-required">미설치 작업 유형입니다. 연결 설정에서 관련 직무 패키지를 설치하면 편집하고 사용할 수 있습니다. 기존 저장 설정은 유지됩니다.</p>' : ''}
      ${custom && !installed(task) ? '<p class="connection-note" id="custom-package-required">기반 작업의 직무 패키지가 미설치 상태여서 지금은 실행할 수 없습니다. 사용자 작업과 편집한 설정은 보존되며 계속 수정할 수 있습니다. 실행하려면 연결 설정에서 기반 패키지를 설치하세요.</p>' : ''}
      ${custom ? `<p class="execution-task-source"><span>사용자 작업</span><small>${esc(task.id)}</small></p>${metadata(task)}${inherited(template || { id: task.template_id, label: task.template_id })}` : ''}
      ${boundaryDetails(task.boundary)}<fieldset class="execution-editor-fields" ${inactive ? 'disabled aria-describedby="execution-package-required"' : ''}>${editor(task)}</fieldset>
      ${custom ? '<p class="help">기본값 복원은 지시문과 backend 설정을 복원합니다. 등록한 작업 유형과 이름·목적·키워드는 유지됩니다.</p>' : ''}
      <div class="dialog-actions execution-settings-actions"><button data-close>닫기</button>${custom ? '<button id="delete-custom-task" class="custom-task-delete">작업 등록 삭제</button>' : ''}<button id="reset-execution" class="secondary" ${task.overridden && !inactive ? '' : 'disabled'}>기본값 복원</button><button id="save-execution" class="primary" ${inactive ? 'disabled' : ''}>저장</button></div>
      ${custom ? `<section id="custom-task-delete-confirmation" class="custom-task-delete-confirmation" aria-label="작업 등록 삭제 확인" hidden><p><strong>${esc(task.label)}</strong> 작업 등록을 삭제할까요? 이후 새 작업에서 선택할 수 없으며, 기존 실행 기록은 유지됩니다.</p><div class="dialog-actions"><button id="cancel-custom-task-delete">취소</button><button id="confirm-custom-task-delete" class="custom-task-delete">등록 삭제</button></div></section>` : ''}`
      : '<p class="help">사용할 수 있는 작업 유형이 없습니다. 직무 패키지를 설치하세요.</p><div class="dialog-actions"><button data-close>닫기</button></div>'}
      </section>`);
    const groupTabs = ['worklog', 'harness'].map(group => $(`#execution-group-${group}`));
    const switchGroup = (index, focus = false) => {
      const group = ['worklog', 'harness'][index]; render(undefined, group);
      if (focus) $(`#execution-group-${group}`).focus();
    };
    groupTabs.forEach((tab, index) => {
      tab.onclick = () => switchGroup(index);
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); switchGroup(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true);
      };
    });
    $('#execution-task').onchange = event => render(event.target.value);
    if ($('#manage-harness-packages')) $('#manage-harness-packages').onclick = () => showConnections?.();
    if ($('#add-custom-task')) $('#add-custom-task').onclick = () => { if ((snapshot.templates || []).length) renderDraftRequest(task?.id); };
    if (!task) return;
    if (!inactive) bindEditor(task);
    $('#save-execution').onclick = () => !inactive && mutate(async () => {
      snapshot = await api(`/execution-settings/${encodeURIComponent(task.id)}`, { method: 'PUT', body: {
        ...executionValues(), ...(custom ? metadataValues() : {})
      } });
      toast('작업 실행 설정을 저장했습니다.'); render(task.id);
    });
    $('#reset-execution').onclick = () => !inactive && mutate(async () => {
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
  function renderDraftRequest(previousId, request = '', priorDraft = null, guide = {}) {
    modal(`<h2>사용자 작업 등록</h2><p>어떤 작업을 맡기고 무엇을 고려해야 하는지 알려 주세요. 내용을 바탕으로 작업 이름, 목적, 키워드와 지시문을 작성합니다.</p>
      ${errorMarkup}
      <section class="custom-draft-guidance" aria-label="작업 설명 안내"><p>다음 내용을 포함하면 원하는 작업에 맞게 작성할 수 있습니다.</p>
        <ul><li><strong>목적과 대상</strong> — 어떤 일을 누구를 위해 하나요?</li><li><strong>입력 자료</strong> — 어떤 정보나 문서를 받나요?</li><li><strong>기대 결과</strong> — 어떤 내용을 어떤 형식으로 만들까요?</li><li><strong>범위와 제외 사항</strong> — 어디까지 수행하고 무엇은 하지 않을까요?</li><li><strong>품질 기준과 제약</strong> — 꼭 확인할 사항이나 지켜야 할 조건이 있나요?</li></ul>
        <details><summary>설명 예시</summary><p>팀 리더에게 공유할 주간 회의 기록을 작성하는 작업입니다. 회의 메모를 받아 결정 사항, 담당자, 마감일을 Markdown 문서로 정리해 주세요. 실제 일정 변경이나 메시지 발송은 하지 않고, 메모에 없는 내용은 추측하지 말고 확인이 필요하다고 표시해야 합니다.</p></details>
      </section>
      <label for="custom-draft-request">어떤 작업을 등록할까요?</label><textarea id="custom-draft-request" maxlength="12000" aria-describedby="custom-draft-help" placeholder="작업의 목적, 입력 자료, 기대 결과와 고려할 사항을 자유롭게 적어 주세요.">${esc(request)}</textarea>
      <p id="custom-draft-help" class="help">작성된 내용은 등록 전에 확인하고 수정할 수 있습니다.${priorDraft ? ' 다시 작성하면 현재 등록 초안이 새 내용으로 바뀝니다.' : ''}</p>
      <p id="custom-draft-status" class="custom-draft-status" role="status" hidden></p>
      <div class="dialog-actions custom-draft-actions"><button id="cancel-custom-draft">취소</button><button id="manual-custom-task" class="secondary">${priorDraft ? '초안으로 돌아가기' : '직접 입력'}</button><button id="cancel-draft-generation" hidden>작성 중단</button><button id="generate-custom-draft" class="primary">등록 내용 작성</button></div>`);
    const input = $('#custom-draft-request'), generate = $('#generate-custom-draft'), cancel = $('#cancel-draft-generation'), status = $('#custom-draft-status'), error = $('#dialog-error');
    let submission;
    $('#cancel-custom-draft').onclick = () => render(previousId);
    $('#manual-custom-task').onclick = () => renderCreate(previousId, priorDraft?.template_id || 'document.create', priorDraft || {}, { ...guide, request: input.value });
    const busy = value => { input.disabled = value; generate.disabled = value; cancel.hidden = !value; };
    const current = work => activeDraft === work && $('#custom-draft-request') === input && $('#modal')?.open;
    const failed = (work, message, terminal = false) => {
      if (!current(work)) return;
      if (terminal) {
        work.settled = true; activeDraft = null;
        if (submission === work.submission) submission = null;
      } else {
        // The worker may still be running when a response is lost. Retain its
        // handle for cancellation and replay the same declaration on retry.
        work.paused = true; clearTimeout(work.timer);
      }
      busy(false);
      cancel.hidden = terminal || !work.id;
      status.hidden = terminal;
      if (!terminal) status.textContent = '작성은 계속 진행 중일 수 있습니다. 같은 요청으로 다시 시도하면 기존 작성 상태를 확인합니다.';
      error.textContent = message; error.hidden = false; error.focus();
    };
    cancel.onclick = () => {
      abandonDraft(); submission = null; busy(false); error.hidden = true; status.hidden = false;
      status.textContent = '작성 중단을 요청했습니다. 요청을 수정하거나 다시 작성할 수 있습니다.';
    };
    generate.onclick = async () => {
      if (activeDraft && !activeDraft.paused) return;
      const request = input.value.trim();
      if (!request) { error.textContent = '등록할 작업과 고려할 사항을 입력해 주세요.'; error.hidden = false; input.focus(); return; }
      if (activeDraft && activeDraft.submission.request !== request) abandonDraft();
      // Retrying a POST whose response was lost reuses its declaration key.
      if (submission?.request !== request) submission = { request, idempotency_key: crypto.randomUUID() };
      error.hidden = true; busy(true); status.hidden = false; status.textContent = '등록 내용을 작성하고 있습니다. 잠시 기다려 주세요.';
      const work = activeDraft || { id: null, settled: false, timer: null, submission };
      work.paused = false;
      activeDraft = work;
      const receive = async result => {
        work.id = result.id;
        if (!current(work)) { if (!draftTerminal.has(result.status)) cancelRemoteDraft(work).catch(() => {}); return; }
        if (result.status === 'completed') {
          work.settled = true;
          const draft = result.draft;
          if (!draft || !snapshot.templates.includes(draft.template_id)) { failed(work, '등록 내용을 불러오지 못했습니다. 요청을 확인하고 다시 작성해 주세요.', true); return; }
          if (submission === work.submission) submission = null;
          const { label, description, routing_terms, instruction } = draft;
          renderCreate(previousId, draft.template_id, { label, description, routing_terms, instruction }, { request, generated: true });
          return;
        }
        if (draftTerminal.has(result.status)) {
          failed(work, result.message || '등록 내용을 작성하지 못했습니다. 요청을 수정하거나 직접 입력해 주세요.', true); return;
        }
        status.textContent = result.status === 'pending' || result.status === 'queued' ? '등록 내용 작성 순서를 기다리고 있습니다.' : '등록 내용을 작성하고 있습니다. 잠시 기다려 주세요.';
        work.timer = setTimeout(async () => {
          if (!current(work)) return;
          try { await receive(await api(`/execution-settings/custom-task-drafts/${encodeURIComponent(work.id)}`)); }
          catch (failure) { failed(work, failure.message); }
        }, 600);
      };
      try {
        const result = await api('/execution-settings/custom-task-drafts', { method: 'POST', body: submission });
        await receive(result);
      }
      catch (failure) { failed(work, failure.message); }
    };
  }
  function renderCreate(previousId, templateId = 'document.create', draft = {}, guide = {}) {
    const templates = (snapshot.templates || []).map(id => snapshot.tasks.find(task => task.id === id)).filter(task => task && installed(task));
    const template = templates.find(task => task.id === templateId) || templates[0];
    const form = template && { ...template, instruction: draft.instruction ?? template.instruction,
      backend: draft.backend ?? (guide.generated ? 'codex' : template.backend),
      backends: Object.fromEntries(['codex', 'claude'].map(engine => [engine, { ...template.backends[engine],
        ...(guide.generated ? { model: null, effort: null } : {}), ...(draft.backends?.[engine] || {}) }])) };
    modal(`<div class="custom-task-registration"><div class="custom-task-registration-body"><h2>사용자 작업 등록</h2><p>기존 작업을 기반으로 자주 사용하는 작업 유형을 등록하세요. 등록한 유형은 설정을 다시 열거나 앱을 다시 시작해도 유지됩니다.</p>
      ${errorMarkup}
      ${guide.generated ? '<p class="custom-draft-status" role="status">등록 내용을 작성했습니다. 내용을 확인한 뒤 등록을 누르세요.</p>' : ''}
      <div class="custom-draft-request-actions"><button id="edit-draft-request" class="secondary">${guide.generated ? '요청 수정·다시 작성' : '설명으로 작성하기'}</button></div>
      <label for="custom-task-template">기반 작업 유형</label><select id="custom-task-template">${templates.map(task => option(task, template?.id)).join('')}</select>
      <p class="help">기반 유형을 바꾸면 지시문과 backend 입력을 새 유형에 맞게 다시 채웁니다.</p>
      ${template ? `${metadata(draft)}${inherited(template)}${boundaryDetails(template.boundary)}${editor(form)}` : '<p class="help">등록에 사용할 수 있는 기반 작업 유형이 없습니다.</p>'}
      </div><div class="dialog-actions custom-task-registration-actions"><button id="cancel-custom-task">취소</button><button id="create-custom-task" class="primary" ${template ? '' : 'disabled'}>등록</button></div></div>`);
    $('#cancel-custom-task').onclick = () => render(previousId);
    if (!template) return;
    $('#edit-draft-request').onclick = () => renderDraftRequest(previousId, guide.request || '', { ...metadataValues(), ...executionValues(), template_id: template.id }, guide);
    $('#custom-task-template').onchange = event => renderCreate(previousId, event.target.value, metadataValues(), guide);
    bindEditor(form);
    $('#create-custom-task').onclick = () => mutate(async () => {
      snapshot = await api('/execution-settings/custom-tasks', { method: 'POST', body: {
        ...executionValues(), ...metadataValues(), template_id: template.id
      } });
      toast('사용자 작업을 등록했습니다.'); render(snapshot.created_task_id);
    });
  }
  async function showSettings() { snapshot = await api('/execution-settings'); render(undefined, 'worklog'); }
  return { showSettings };
}
