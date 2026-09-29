import { loadSettingsModal } from './settings-tabs.js';
export function automationSettingsUI({ api, esc, modal, toast }) {
  const $ = selector => document.querySelector(selector);
  async function showSettings() {
    const settings = await loadSettingsModal({ modal, title: '자동 작성 설정', load: () => api('/automation/settings'), retry: showSettings });
    if (!settings) return;
    modal(`<h2>자동 작성 설정</h2><p>대화가 쌓이면 업무 제목·설명을 자동 갱신합니다. 이 컴퓨터의 모든 업무에 적용됩니다.</p>
      <form id="automation-settings-form">
        <div id="automation-settings-error" class="error" role="alert" hidden></div>
        <section class="automation-setting"><h3>세션 자동 요약</h3>
          <label><input id="session-summary-enabled" type="checkbox" ${settings.session_summary_enabled ? 'checked' : ''}> 세션 자동 요약 사용</label>
          <p class="help">20분 이상 활동이 없는 세션을 최대 5개씩 요약합니다. 끄면 대기 중인 자동 요약을 멈춥니다. 이미 시작한 요약과 수동 요약은 유지됩니다.</p></section>
        <section class="automation-setting" aria-labelledby="initial-output-heading">
          <h3 id="initial-output-heading">첫 구조화 갱신</h3>
          <label for="initial-output-count">에이전트 응답 수</label>
          <div class="threshold-input"><input id="initial-output-count" name="initial_output_count" type="number" min="1" max="1000" step="1" required value="${esc(settings.initial_output_count)}" aria-describedby="initial-output-help"><span>회</span></div>
          <p class="help" id="initial-output-help">설정한 응답 수에 도달하면 제목·설명을 처음 갱신합니다. 내부 작업과 중복 기록은 제외합니다.</p>
        </section>
        <section class="automation-setting" aria-labelledby="summary-interval-heading">
          <h3 id="summary-interval-heading">이후 구조화 갱신</h3>
          <label for="summary-interval">요약된 종료 세션 수</label>
          <div class="threshold-input"><input id="summary-interval" name="summary_interval" type="number" min="1" max="1000" step="1" required value="${esc(settings.summary_interval)}" aria-describedby="summary-interval-help"><span>개마다</span></div>
          <p class="help" id="summary-interval-help">예: 5개로 설정하면 세션 요약이 5개 쌓일 때마다 갱신합니다. 재요약은 제외합니다.</p>
        </section>
        <p class="help">1~1,000까지 입력할 수 있습니다. 저장 후 다음 자동 작성부터 적용됩니다.</p>
        <p class="help">직접 편집한 제목·설명은 유지합니다. 필요하면 업무 상세에서 ‘다시 작성’을 누르세요.</p>
        <div class="dialog-actions"><button type="button" data-close>닫기</button><button type="button" id="reset-automation-settings" class="secondary">기본값 입력</button><button type="submit" id="save-automation-settings" class="primary">저장</button></div>
      </form>`);
    const form = $('#automation-settings-form');
    $('#reset-automation-settings').onclick = () => { $('#session-summary-enabled').checked = true; $('#initial-output-count').value = 5; $('#summary-interval').value = 5; };
    form.onsubmit = async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const error = $('#automation-settings-error');
      const initial_output_count = $('#initial-output-count').valueAsNumber, summary_interval = $('#summary-interval').valueAsNumber;
      if (![initial_output_count, summary_interval].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1000)) {
        error.textContent = '각 기준은 1~1,000 사이의 정수로 입력하세요.'; error.hidden = false; return;
      }
      const controls = [...form.querySelectorAll('input, #save-automation-settings, #reset-automation-settings')];
      controls.forEach(control => control.disabled = true); form.setAttribute('aria-busy', 'true'); error.hidden = true;
      try {
        const saved = await api('/automation/settings', { method: 'PATCH', body: { initial_output_count, summary_interval, session_summary_enabled: $('#session-summary-enabled').checked } });
        if (!form.isConnected) return;
        $('#initial-output-count').value = saved.initial_output_count; $('#summary-interval').value = saved.summary_interval;
        toast('자동 작성 기준을 저장했습니다.');
      } catch (e) { if (form.isConnected) { error.textContent = e.message; error.hidden = false; } }
      finally { controls.forEach(control => control.disabled = false); form.removeAttribute('aria-busy'); }
    };
  }
  return { showSettings };
}
