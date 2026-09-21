export function automationSettingsUI({ api, esc, modal, toast }) {
  const $ = selector => document.querySelector(selector);
  async function showSettings() {
    const settings = await api('/automation/settings');
    modal(`<h2>자동 작성 설정</h2><p>수집된 대화와 세션 요약을 기준으로 업무 제목·설명을 자동 갱신합니다. 이 컴퓨터의 모든 업무에 적용합니다.</p>
      <form id="automation-settings-form">
        <div id="automation-settings-error" class="error" role="alert" hidden></div>
        <section class="automation-setting" aria-labelledby="initial-output-heading">
          <h3 id="initial-output-heading">처음 제목·설명 만들기</h3>
          <label for="initial-output-count">에이전트 응답 수</label>
          <div class="threshold-input"><input id="initial-output-count" name="initial_output_count" type="number" min="1" max="1000" step="1" required value="${esc(settings.initial_output_count)}" aria-describedby="initial-output-help"><span>회</span></div>
          <p class="help" id="initial-output-help">업무에 연결된 사용자 에이전트 세션의 응답을 합산합니다. 내부 워커 출력과 중복 수집은 제외합니다.</p>
        </section>
        <section class="automation-setting" aria-labelledby="summary-interval-heading">
          <h3 id="summary-interval-heading">이후 제목·설명 갱신하기</h3>
          <label for="summary-interval">요약된 종료 세션 수</label>
          <div class="threshold-input"><input id="summary-interval" name="summary_interval" type="number" min="1" max="1000" step="1" required value="${esc(settings.summary_interval)}" aria-describedby="summary-interval-help"><span>개마다</span></div>
          <p class="help" id="summary-interval-help">5개로 설정하면 종료 세션의 요약이 5개, 10개, 15개 쌓일 때 갱신합니다. 같은 세션의 재요약은 추가로 세지 않습니다.</p>
        </section>
        <p class="help">1~1,000까지 설정할 수 있습니다. 저장한 기준은 다음 자동 작성부터 적용합니다. 이미 지난 기준은 최신 이력으로 한 번만 처리하고, 진행 중인 작성은 중복 실행하지 않습니다.</p>
        <p class="help">직접 편집한 제목·설명은 자동으로 덮어쓰지 않습니다. 업무 상세의 ‘다시 작성’은 언제든 사용할 수 있습니다.</p>
        <div class="dialog-actions"><button type="button" data-close>닫기</button><button type="button" id="reset-automation-settings" class="secondary">기본값 입력</button><button type="submit" id="save-automation-settings" class="primary">저장</button></div>
      </form>`);
    const form = $('#automation-settings-form');
    $('#reset-automation-settings').onclick = () => { $('#initial-output-count').value = 5; $('#summary-interval').value = 5; };
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
        const saved = await api('/automation/settings', { method: 'PATCH', body: { initial_output_count, summary_interval } });
        if (!form.isConnected) return;
        $('#initial-output-count').value = saved.initial_output_count; $('#summary-interval').value = saved.summary_interval;
        toast('자동 작성 기준을 저장했습니다.');
      } catch (e) { if (form.isConnected) { error.textContent = e.message; error.hidden = false; } }
      finally { controls.forEach(control => control.disabled = false); form.removeAttribute('aria-busy'); }
    };
  }
  return { showSettings };
}
