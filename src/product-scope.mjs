// Historical task definitions remain readable; new work is limited to history utilities.
export const historyTasks = new Set(['session.summarize', 'text.rewrite', 'work.report.create', 'work-item.result.summarize']);
export const retiredWorkMessage = 'WorkLog는 세션 이력 수집·정리만 지원합니다. 하네스 위임과 직무 패키지 작업은 제거되었습니다.';
export function historySettings(snapshot) {
  return { ...snapshot, tasks: snapshot.tasks.filter(task => historyTasks.has(task.id)), templates: [] };
}
