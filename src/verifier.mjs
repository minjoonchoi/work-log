import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assert, digest, atomic, json } from './shared.mjs';
import { checkScenarios } from './scenarios.mjs';
import { validateSchema } from './schema.mjs';
import { parseSessionSummary } from './session-summary.mjs';
import { parseTextRewrite } from './text-rewrite.mjs';

export function artifact(cwd, file) {
  const candidate = path.resolve(cwd, file), root = fs.realpathSync(cwd);
  assert(candidate.startsWith(`${path.resolve(cwd)}${path.sep}`), '산출물이 허용 경로 밖에 있습니다.');
  assert(fs.lstatSync(candidate).isFile() && !fs.lstatSync(candidate).isSymbolicLink(), '산출물은 일반 파일이어야 합니다.');
  assert(fs.realpathSync(candidate).startsWith(`${root}${path.sep}`), '산출물 경로가 작업 공간을 벗어났습니다.');
  const bytes = fs.readFileSync(candidate);
  assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, '빈 산출물 또는 크기 제한을 초과한 산출물입니다.');
  return { path: candidate, bytes, content_digest: digest(bytes) };
}
export async function verify(cwd, job, input, evidenceDir) {
  const subject = artifact(cwd, job.file), text = subject.bytes.toString('utf8');
  const checks = job.requiredSections.map(section => ({ rule: 'OUTPUT-001', check: section, passed: text.includes(section) }));
  const unexpected = fs.readdirSync(cwd).filter(name => name !== job.file);
  checks.push({ rule: 'SCOPE-001', check: 'allowed files', passed: unexpected.length === 0, unexpected });
  if (job.artifact_schema) {
    try { validateSchema(job.artifact_schema, JSON.parse(text), '산출물 JSON'); checks.push({ rule: 'OUTPUT-001', check: 'artifact schema', passed: true }); }
    catch (e) { checks.push({ rule: 'OUTPUT-001', check: 'artifact schema', passed: false, error: e.message }); }
  }
  if (job.kind === 'scenario_plan') checks.push(...checkScenarios(text, input));
  if (job.kind === 'session_summary') {
    try { parseSessionSummary(text); checks.push({ rule: 'SUMMARY-001', check: 'one title and at most five summary lines', passed: true }); }
    catch (e) { checks.push({ rule: 'SUMMARY-001', check: 'one title and at most five summary lines', passed: false, error: e.message }); }
  }
  if (job.kind === 'text_rewrite') {
    try { parseTextRewrite(text, input.format); checks.push({ rule: 'REWRITE-001', check: input.format, passed: true }); }
    catch (e) { checks.push({ rule: 'REWRITE-001', check: input.format, passed: false, error: e.message }); }
  }
  if (job.kind === 'html') {
    let browser, deadline;
    try {
      const { chromium } = await import('playwright');
      const executablePath = process.env.HARNESS_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      browser = await chromium.launch(fs.existsSync(executablePath) ? { executablePath, headless: true } : { headless: true });
      deadline = setTimeout(() => { void browser.close().catch(() => {}); }, 30000);
      assert(Array.isArray(input.browser_checks || []) && (input.browser_checks || []).length <= 20, '브라우저 검사는 최대 20개입니다.');
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        let allowed = false;
        try { allowed = url.startsWith('file:') && fileURLToPath(url) === subject.path; } catch {}
        return allowed ? route.continue() : route.abort();
      });
      await page.goto(pathToFileURL(subject.path).href);
      for (const check of input.browser_checks || []) {
        assert(typeof check.click === 'string' && typeof check.visible === 'string', '브라우저 검사에는 click, visible이 필요합니다.');
        await page.locator(check.click).click({ timeout: 3000 });
        await page.locator(check.visible).waitFor({ state: 'visible', timeout: 3000 });
        if (check.text) assert((await page.locator(check.visible).innerText()).includes(check.text), '요청한 상호작용 결과가 다릅니다.');
      }
      await page.screenshot({ path: path.join(evidenceDir, 'browser.png'), fullPage: true });
      checks.push({ rule: 'OUTPUT-001', check: 'browser', passed: errors.length === 0, errors, interaction_count: (input.browser_checks || []).length });
    } catch (e) { checks.push({ rule: 'OUTPUT-001', check: 'browser', passed: false, error: e.message }); }
    finally { clearTimeout(deadline); await browser?.close(); }
  }
  const report = { subject_digest: subject.content_digest, passed: checks.every(c => c.passed), checks };
  atomic(path.join(evidenceDir, 'verification.json'), json(report));
  return { ...report, subject };
}
