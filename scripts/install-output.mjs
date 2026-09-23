// CLI presentation only. Installation records and programmatic results remain structured.
export function createInstallReporter({ json = false } = {}) {
  return {
    progress(message) { if (!json) console.error(`[WorkLog] ${message}`); },
    result(operation, result) {
      console.log(json ? JSON.stringify(result) : formatResult(operation, result));
    },
    error(operation, error) {
      console.error(json ? JSON.stringify({ error: error.message })
        : `[WorkLog] ${operation === 'uninstall' ? '제거' : '설치'} 실패\n  ${error.message}`);
    }
  };
}

function formatResult(operation, result) {
  const lines = [];
  const field = (label, value) => { if (value) lines.push(`  ${label}: ${value}`); };
  if (operation === 'install') {
    if (['installed', 'reinstalled'].includes(result.status)) {
      lines.push(result.status === 'reinstalled' ? '[WorkLog] 재설치 완료' : '[WorkLog] 설치 완료');
      field('앱', result.installed);
      field('서비스', result.activated ? '시작됨' : '시작하지 않음 (--no-activate)');
      field('업무 데이터', result.data_root);
      lines.push('  Claude·Codex 연결은 앱의 연결 설정에서 관리할 수 있습니다.');
    } else if (result.status === 'already_installed') {
      lines.push('[WorkLog] 기존 설치 유지');
      field('앱', result.installed);
      lines.push(`  ${result.note}`);
    } else {
      lines.push('[WorkLog] 설치 계획 · 아직 설치하지 않았습니다.');
      field('원본 앱', result.sourceApp);
      field('설치할 앱', result.targetApp);
      field('업무 데이터', result.dataDir);
      field('서비스', `${result.files.length}개`);
      field('계획 파일', result.output && `${result.output}/plan.json`);
      lines.push('  make install로 설치할 수 있습니다.');
    }
    const cleanup = result.build_cleanup;
    if (cleanup?.removed.length) field('중복 빌드 앱 정리', `${cleanup.removed.length}개`);
    if (cleanup?.preserved.length) {
      lines.push('  정리하지 않고 보존한 빌드 경로:');
      for (const row of cleanup.preserved) lines.push(`    - ${row.path}\n      사유: ${row.reason}`);
    }
  } else {
    const titles = {
      planned: '제거 계획 · 아직 제거하지 않았습니다.',
      uninstalled: '제거 완료',
      not_installed: '설치 내역 없음',
      unmanaged: '제거 확인 필요',
      needs_attention: '제거 확인 필요'
    };
    lines.push(`[WorkLog] ${titles[result.status] || result.status}`);
    if (result.status === 'planned') {
      field('제거할 앱', result.app);
      field('실행 파일', result.runtime);
      field('서비스 설정', `${result.files.length}개`);
      field('훅 연결', `${result.hooks.length}개`);
      field('스킬 연결', `${result.links.length}개`);
      lines.push('  make uninstall로 제거할 수 있습니다.');
    } else if (result.status === 'unmanaged') {
      lines.push('  소유 기록이 없는 설치 항목이 있어 제거하지 않았습니다.');
    } else if (result.removed) {
      field('제거한 항목', `${result.removed.length}개`);
    }
    if (result.preserved?.length) {
      lines.push('  다음 항목을 제거하지 못해 보존했습니다:');
      for (const row of result.preserved) lines.push(`    - ${row.path}\n      사유: ${row.reason}`);
      lines.push('  보존 사유를 확인한 뒤 make uninstall을 다시 실행하세요.');
    }
    field('보관 데이터', result.data_root);
    if (result.preserve?.length) field('보존할 데이터', result.preserve.join(' · '));
    if (result.note) lines.push(`  ${result.note}`);
  }
  return lines.join('\n');
}
