import path from 'node:path';
import { Harness, pair, eventually } from '../tests/helpers.mjs';
import { ROOT } from '../src/shared.mjs';
const h = await new Harness(path.join(ROOT, 'output/native-data')).start('runtime'); await h.start('manager');
const samples = [
  ['prd', '권한 관리 기능 PRD', '제품 요구사항과 승인·거절 상태의 수용 기준 정리'],
  ['mockup', '워크스페이스 초대 화면 목업', '초대 링크, 멤버 역할, 오류 상태를 담은 동작형 HTML'],
  ['entity', '멤버십 엔티티와 API 설계', '조직·멤버·역할의 관계와 생명주기 설계'],
  ['review', '온보딩 흐름 검토', '사용자 여정에서 빈 상태와 접근 권한 누락 확인'],
  ['report', '주간 진행 보고', '이번 주 결정 사항과 다음 작업의 의존성 정리']
];
for (let i = 0; i < samples.length; i++) {
  const [agent, title] = samples[i];
  await h.ingest(pair(agent, `2026-09-17T0${9}:00:00+09:00`, '2026-09-17T09:35:00+09:00', 'one', { text: title }));
  await h.ingest(pair(agent, `2026-09-${14 + i}T13:00:00+09:00`, `2026-09-${14 + i}T13:45:00+09:00`, 'two', { text: title }));
}
const run = await h.run({ prompt: '권한 관리 PRD · 검증된 산출물 예시', fixture: { scenario: 'revise-once' } }); await h.finish(run);
console.log(JSON.stringify({ ready: true, data_root: h.dir, run: run.id }));
const keepAlive = setInterval(() => {}, 1000);
async function stop() { clearInterval(keepAlive); await h.close(false); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
