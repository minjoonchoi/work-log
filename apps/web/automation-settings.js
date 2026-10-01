import { loadSettingsModal } from './settings-tabs.js';
export function automationSettingsUI({ api, esc, modal, toast }) {
  const $ = selector => document.querySelector(selector);
  async function showSettings() {
    const settings = await loadSettingsModal({ modal, title: '자동 작성 설정', load: () => api('/automation/settings'), retry: showSettings });
    if (!settings) return;
    modal(`<h2>자동 작성 설정</h2><p>모든 업무의 자동 요약 기준을 설정합니다.</p>
      <form id="automation-settings-form">
        <div id="automation-settings-error" class="error" role="alert" hidden></div>
        <section class="automation-setting"><h3>세션 자동 요약</h3>
          <label><input id="session-summary-enabled" type="checkbox" ${settings.session_summary_enabled ? 'checked' : ''}> 세션 자동 요약 사용</label>
          <label for="session-summary-idle-minutes">비활동 후 요약 대기 시간</label>
          <div class="threshold-input"><input id="session-summary-idle-minutes" name="session_summary_idle_minutes" type="number" min="1" max="1000" step="1" required value="${esc(settings.session_summary_idle_minutes)}"><span>분</span></div>
          <p class="help">비활동 시간이 지나거나 세션이 종료되면 요약합니다. 진행 중인 응답·작업은 제외합니다. 끄면 대기 중인 자동 요약만 멈춥니다.</p></section>
        <section class="automation-setting" aria-labelledby="work-summary-heading">
          <h3 id="work-summary-heading">업무 자동 요약</h3>
          <label><input id="work-summary-enabled" type="checkbox" ${settings.work_summary_enabled ? 'checked' : ''}> 업무 자동 요약 사용</label>
          <p class="help">업무 제목·설명을 자동 작성합니다. 끄면 새 예약과 대기 중인 자동 작성을 멈춥니다.</p>
          <h4>첫 요약 기준</h4>
          <label for="initial-output-count">에이전트 응답 수</label>
          <div class="threshold-input"><input id="initial-output-count" name="initial_output_count" type="number" min="1" max="1000" step="1" required value="${esc(settings.initial_output_count)}" aria-describedby="initial-output-help"><span>회</span></div>
          <p class="help" id="initial-output-help">응답이 이 횟수만큼 쌓이면 처음 요약합니다.</p>
          <h4>이후 요약 갱신 기준</h4>
          <label for="summary-interval">요약 완료 세션 수</label>
          <div class="threshold-input"><input id="summary-interval" name="summary_interval" type="number" min="1" max="1000" step="1" required value="${esc(settings.summary_interval)}" aria-describedby="summary-interval-help"><span>개마다</span></div>
          <p class="help" id="summary-interval-help">새 세션 요약이 이 개수만큼 쌓일 때마다 갱신합니다.</p>
        </section>
        <p class="help">입력 범위: 1~1,000 · 저장 후 다음 요약부터 적용</p>
        <p class="help">직접 편집한 제목·설명은 유지합니다.</p>
        <div class="dialog-actions"><button type="button" data-close>닫기</button><button type="button" id="reset-automation-settings" class="secondary">기본값 입력</button><button type="submit" id="save-automation-settings" class="primary">저장</button></div>
      </form>`);
    const form = $('#automation-settings-form');
    $('#reset-automation-settings').onclick = () => { $('#session-summary-enabled').checked = true; $('#work-summary-enabled').checked = true; $('#session-summary-idle-minutes').value = 15; $('#initial-output-count').value = 5; $('#summary-interval').value = 5; };
    form.onsubmit = async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const error = $('#automation-settings-error');
      const initial_output_count = $('#initial-output-count').valueAsNumber, summary_interval = $('#summary-interval').valueAsNumber;
      const session_summary_idle_minutes = $('#session-summary-idle-minutes').valueAsNumber;
      if (![initial_output_count, summary_interval, session_summary_idle_minutes].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1000)) {
        error.textContent = '각 기준은 1~1,000 사이의 정수로 입력하세요.'; error.hidden = false; return;
      }
      const controls = [...form.querySelectorAll('input, #save-automation-settings, #reset-automation-settings')];
      controls.forEach(control => control.disabled = true); form.setAttribute('aria-busy', 'true'); error.hidden = true;
      try {
        const saved = await api('/automation/settings', { method: 'PATCH', body: { initial_output_count, summary_interval, session_summary_idle_minutes, work_summary_enabled: $('#work-summary-enabled').checked, session_summary_enabled: $('#session-summary-enabled').checked } });
        if (!form.isConnected) return;
        $('#session-summary-idle-minutes').value = saved.session_summary_idle_minutes; $('#initial-output-count').value = saved.initial_output_count; $('#summary-interval').value = saved.summary_interval;
        toast('자동 작성 기준을 저장했습니다.');
      } catch (e) { if (form.isConnected) { error.textContent = e.message; error.hidden = false; } }
      finally { controls.forEach(control => control.disabled = false); form.removeAttribute('aria-busy'); }
    };
  }
  return { showSettings };
}
