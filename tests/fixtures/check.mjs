import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2], directory = process.env.HARNESS_CHECK_ATTEMPT_DIR;
if (mode === 'slow') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(directory, 'child.pid'), String(child.pid));
  await new Promise(r => setTimeout(r, 2000));
  child.kill();
}
if (mode === 'change-source') fs.appendFileSync('tests/fixtures/check-source.txt', 'changed\n');
if (mode === 'flood') { for (let i = 0; i < 1200; i++) process.stderr.write('x'.repeat(4096)); }
process.stdout.write('관찰한 검사 출력\n');
if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.HARNESS_LIVE_APPROVED) throw new Error('모델 호출 권한이 검사 프로세스에 전달됨');
if (mode === 'fail') { process.stderr.write('의도한 검사가 실패했습니다.\n'); process.exitCode = 7; }
