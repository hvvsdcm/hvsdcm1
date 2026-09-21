import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const artifacts = process.env.WORDMASTER_E2E_ARTIFACT_DIR || '';
const words = Array.from({ length: 2000 }, (_, i) => ({ id: `w${i + 1}`, word: `word${i + 1}`, meaning: `뜻${i + 1}`, meanings: [`뜻${i + 1}`], day: Math.floor(i / 40) + 1, number: i % 40 + 1 }));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(ROOT, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
    if (!file.startsWith(resolve(ROOT) + sep)) { response.writeHead(403); response.end(); return; }
    const content = await readFile(file);
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let assertions = 0;
const checked = (condition, message) => { assert.ok(condition, message); assertions++; };
async function setup({ progress = null, delay = 0, width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  let remote = progress;
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => { localStorage.setItem('hvsdcm.token', 'local-test-user-token'); localStorage.setItem('hvsdcm.user', 'fixture-user'); });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = {};
    if (path === '/api/learning/wordmaster') body = { words };
    else if (path === '/api/progress/wordmaster') {
      if (request.method() === 'PUT') { remote = request.postDataJSON().data; body = { ok: true }; }
      else { if (delay) await new Promise(resolve => setTimeout(resolve, delay)); body = { data: remote }; }
    } else if (path === '/api/answers/wordmaster') body = { answers: [] };
    else if (path === '/api/answers/accept') body = { ok: true };
    else if (path === '/api/me') body = { user: { id: 1, username: 'fixture-user' } };
    else throw new Error(`Unexpected learning endpoint ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${origin}/WordMaster/`);
  await page.getByRole('heading', { name: '오늘의 학습', exact: true }).waitFor();
  return { context, page, errors, getRemote: () => remote };
}
try {
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const f = await setup();
  const { page } = f;
  checked(await page.locator('#dailyStartBtn').textContent().then(x => x.includes('바로 시작하기')), 'one-tap daily start');
  await page.click('#editDailyGoal');
  await page.fill('#dailyGoalInput', '5');
  await page.fill('#dailyStartDay', '1');
  await page.fill('#dailyEndDay', '1');
  await page.locator('#dailyGoalForm').getByRole('button', { name: '목표 저장하기' }).click();
  checked(await page.locator('.wm-goal-number').textContent().then(x => x.includes('5개')), 'goal persists in UI');
  await page.click('#dailyStartBtn');
  await page.locator('#answerInput').waitFor();
  checked(await page.locator('.wm-word').textContent() === 'word1', 'first new word');
  await page.click('#dontKnowBtn');
  checked(await page.locator('.wm-recall-info').textContent().then(x => x.includes('10분')), 'incorrect schedules short review');
  let data = await page.evaluate(() => JSON.parse(localStorage.getItem('wordmaster2000.quiz.v1')));
  checked(data.learning.activeSession.questions.length === 6, 'single retry queued');
  checked(Object.values(data.learning.days)[0].count === 1, 'wrong answer counts distinct exposure once');
  await page.waitForTimeout(450);
  await page.reload();
  await page.locator('#dailyStartBtn').waitFor();
  checked(await page.locator('#dailyStartBtn').textContent().then(x => x.includes('이어서')), 'reload offers resume');
  await page.click('#dailyStartBtn');
  checked(await page.locator('#answerInput').isDisabled(), 'answered card resumes without grading twice');
  await page.click('#submitBtn');
  for (let guard = 0; guard < 10; guard++) {
    if (await page.locator('#resultHomeBtn').count()) break;
    const term = await page.locator('.wm-word').textContent();
    await page.fill('#answerInput', `뜻${term.replace('word', '')}`);
    await page.click('#submitBtn');
    if (await page.locator('[data-recall-grade="easy"]').count()) {
      await page.click('[data-recall-grade="easy"]');
      await page.click('[data-recall-grade="good"]');
    }
    await page.click('#submitBtn');
  }
  await page.locator('#resultHomeBtn').waitFor();
  data = await page.evaluate(() => JSON.parse(localStorage.getItem('wordmaster2000.quiz.v1')));
  checked(Object.values(data.learning.days)[0].count === 5, 'retry does not inflate daily goal');
  checked(Object.values(data.learning.days)[0].attempts === 6, 'actual attempt count retained');
  checked(data.learning.cards.w1.repetitions === 0, 'immediate retry does not claim spaced mastery');
  checked(data.learning.activeSession === null, 'completed session cleared');
  await page.click('#resultHomeBtn');
  checked(await page.locator('.wm-goal-message').textContent().then(x => x.includes('목표 달성')), 'goal completion feedback');
  await page.click('#dailyReviewBtn');
  checked(await page.locator('#startScheduledReview').isDisabled(), 'future reviews not exposed as due');
  await page.click('#homeLogo');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    checked(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow ${width}`);
    const button = await page.locator('#dailyStartBtn').boundingBox();
    checked(button && button.width >= 180 && button.height >= 44 && button.x >= 0 && button.x + button.width <= width + 1, `usable primary action ${width}`);
    if (artifacts) await page.screenshot({ path: join(artifacts, `daily-${width}.png`), fullPage: true });
  }
  await page.click('#dailyRangeBtn');
  await page.locator('#startQuizBtn').waitFor();
  checked(await page.locator('#startDay').count() === 1, 'legacy range controls retained');
  await page.click('#openStatsBtn');
  await page.fill('#wrongSearchInput', 'word1');
  checked(await page.locator('#wrongEntriesList').textContent().then(x => x.includes('word1')), 'wrong-note search retained');
  checked(f.errors.length === 0, `no browser errors: ${f.errors.join(', ')}`);
  await f.context.close();

  const legacy = { version: 1, stats: { w1: { attempts: 3, correct: 2, wrong: 1, lastAt: Date.now() - 86400000 } }, wrongBank: {}, customAliases: { w1: ['별칭'] }, sessions: 2 };
  const delayed = await setup({ progress: legacy, delay: 300 });
  checked(await delayed.page.locator('.wm-review-count').textContent().then(x => x.includes('1')), 'waits for remote hydration before SRS migration');
  await delayed.page.click('#dailyStartBtn');
  await delayed.page.fill('#answerInput', '별칭');
  await delayed.page.click('#submitBtn');
  checked((await delayed.page.locator('.wm-verdict').textContent()).includes('정답'), 'existing custom answer retained');
  checked(delayed.errors.length === 0, 'hydration race causes no browser errors');
  await delayed.context.close();

  const quickReload = await setup({ progress: { version: 1, stats: {}, wrongBank: {}, customAliases: {}, updatedAt: 1 } });
  await quickReload.page.click('#editDailyGoal');
  await quickReload.page.fill('#dailyGoalInput', '37');
  await quickReload.page.locator('#dailyGoalForm').getByRole('button', { name: '목표 저장하기' }).click();
  await quickReload.page.reload();
  await quickReload.page.locator('#dailyStartBtn').waitFor();
  checked(await quickReload.page.locator('.wm-goal-number').textContent().then(x => x.includes('37개')), 'immediate reload preserves unsynced current-account goal');
  await quickReload.context.close();

  const override = await setup();
  await override.page.click('#dailyStartBtn');
  await override.page.fill('#answerInput', '다른 표현');
  await override.page.click('#submitBtn');
  await override.page.click('#acceptMineBtn');
  const corrected = await override.page.evaluate(() => JSON.parse(localStorage.getItem('wordmaster2000.quiz.v1')));
  checked(corrected.stats.w1.correct === 1 && corrected.stats.w1.wrong === 0, 'accepted answer repairs scores');
  checked(Object.values(corrected.learning.days)[0].correct === 1, 'accepted answer repairs daily accuracy');
  checked(corrected.learning.activeSession.questions.length === 20, 'accepted answer removes false retry');
  checked(corrected.learning.cards.w1.repetitions === 1, 'accepted answer repairs review schedule');
  await override.context.close();

  const admin = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const adminPage = await admin.newPage();
  const adminErrors = []; adminPage.on('pageerror', error => adminErrors.push(error.message));
  let resets = 0;
  await admin.addInitScript(() => sessionStorage.setItem('hvsdcm.admin', 'local-admin-fixture-token'));
  await admin.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/admin/users') body = { users: [{ id: 1, username: 'fixture-user', created_at: Date.now(), active_devices: 1, logins: 2, word_events: 2, sm_events: 0, pl_events: 0 }] };
    else if (path === '/api/admin/stats') body = { totals: { users: 1, active_sessions: 1, events_24h: 1, known_ips_30d: 1, shared_answers: 0 } };
    else if (path === '/api/admin/answers') body = { answers: [] };
    else if (path === '/api/admin/sessions') body = { sessions: [] };
    else if (path === '/api/admin/users/1/password') {
      const input = route.request().postDataJSON();
      assert.ok(typeof input.password === 'string' && input.password.length >= 6); resets++; body = { ok: true };
    } else throw new Error(`Unexpected admin endpoint ${path}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await adminPage.goto(`${origin}/admin/`);
  await adminPage.locator('#adminShell').waitFor({ state: 'visible' });
  await adminPage.locator('.sidebar-item[data-view="users"]').click();
  await adminPage.locator('.reset-password').click();
  await adminPage.fill('#resetPassword', 'fixture-password-A');
  await adminPage.fill('#resetPasswordConfirm', 'fixture-password-B');
  await adminPage.click('#passwordResetSubmit');
  checked(resets === 0, 'mismatched reset does not reach server');
  checked(await adminPage.locator('#passwordResetError').textContent().then(x => x.includes('일치')), 'mismatch feedback');
  await adminPage.fill('#resetPasswordConfirm', 'fixture-password-A');
  await adminPage.click('#passwordResetSubmit');
  await adminPage.locator('#passwordResetDialog').waitFor({ state: 'hidden' });
  checked(resets === 1, 'single authenticated reset action');
  checked(await adminPage.locator('#resetPassword').inputValue() === '', 'password inputs cleared after reset');
  checked(await adminPage.locator('#userStatus').textContent().then(x => x.includes('유지')), 'progress preservation feedback');
  await adminPage.locator('.reset-password').click();
  if (artifacts) await adminPage.screenshot({ path: join(artifacts, 'admin-reset-mobile.png'), fullPage: true });
  const bounds = await adminPage.locator('#passwordResetDialog').boundingBox();
  checked(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'mobile reset dialog fits screen');
  await adminPage.click('#passwordResetCancel');
  checked(resets === 1, 'cancelling does not reset');
  checked(adminErrors.length === 0, `no admin browser errors: ${adminErrors.join(', ')}`);
  await admin.close();
  console.log(`WordMaster/admin browser E2E passed (${assertions} assertions).`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
