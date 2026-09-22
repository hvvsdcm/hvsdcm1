import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium, expect } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = process.env.STUDY_UI_ARTIFACT_DIR || '';
async function browserGlobal(file, name) {
  const context = { window: {} };
  vm.runInNewContext(await readFile(join(ROOT, file), 'utf8'), context, { filename: file });
  return context.window[name];
}
const words = await browserGlobal('_learning/wordmaster/words.js', 'WORDMASTER_WORDS');
const sm = {
  data: await browserGlobal('_learning/smstudy/data.js', 'SMSTUDY_DATA'),
  notebook: await browserGlobal('_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK'),
  explanations: await browserGlobal('_learning/smstudy/explanation-data.js', 'SMSTUDY_EXPLANATIONS'),
};
assert.equal(words.length, 2000);
assert.equal(sm.data.QUESTIONS.length, 98);
assert.equal(sm.data.UNITS.flatMap(u => u.subs).length, 17);
const oldPaper = { id: '2020-csat-korean-question', subject: 'korean', year: 2020, grade_year: 2021, round: 'csat', track: null, kind: 'question', r2_key: 'fixture-old.pdf', pages: 6, canonical_form: 'odd' };
const newPaper = { id: '2025-csat-korean-hwajak-question', subject: 'korean', year: 2025, grade_year: 2026, round: 'csat', track: 'hwajak', kind: 'question', r2_key: 'fixture-new.pdf', pages: 6, canonical_form: 'odd', sections: { common: [1, 4], selection: [5, 6] } };
const answer = { ...oldPaper, id: oldPaper.id.replace('question', 'answer'), kind: 'answer', r2_key: 'fixture-answer.pdf', pages: 1, answer_pages: [1] };
const manifest = { exams: [oldPaper, newPaper, answer] };
const pdfContext = vm.createContext({ setTimeout, clearTimeout, Uint8Array, ArrayBuffer });
vm.runInContext(await readFile(join(ROOT, 'assets/vendor/pdf-lib/pdf-lib.min.js'), 'utf8'), pdfContext);
const PDF = pdfContext.PDFLib.PDFDocument;
const makePdf = async count => { const doc = await PDF.create(); for (let i = 0; i < count; i++) doc.addPage(); return Buffer.from(await doc.save()); };
const paperBytes = await makePdf(6);
const answerBytes = await makePdf(1);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(ROOT, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
    if (!file.startsWith(resolve(ROOT) + sep)) { response.writeHead(403); response.end(); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const apiErrors = [];
const contexts = [];
async function setup(path, { width = 390, loggedIn = true, reducedMotion = 'reduce', brokenContent = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light', reducedMotion, acceptDownloads: true });
  contexts.push(context);
  const saved = {};
  const calls = [];
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  if (loggedIn) await context.addInitScript(() => { localStorage.setItem('hvsdcm.token', 'synthetic-test-session'); localStorage.setItem('hvsdcm.user', 'synthetic-student'); });
  let failPdf = false;
  await context.route('**/api/**', async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const p = url.pathname;
      calls.push({ path: p, method: request.method() });
      let body;
      if (p === '/api/me') body = { user: { id: 1, username: 'synthetic-student' } };
      else if (/^\/api\/progress\//.test(p)) {
        if (request.method() === 'PUT') { saved[p] = request.postDataJSON().data; body = { ok: true }; }
        else body = { data: saved[p] || null };
      } else if (/^\/api\/answers\//.test(p)) body = request.method() === 'POST' ? { ok: true } : { answers: [] };
      else if (p === '/api/learning/wordmaster') body = brokenContent ? {} : { words };
      else if (p === '/api/learning/smstudy') body = brokenContent ? {} : sm;
      else if (p.startsWith('/api/learning/smstudy/image/')) {
        const bytes = await readFile(join(ROOT, '_learning/smstudy/kice', basename(p)));
        await route.fulfill({ contentType: 'image/webp', body: bytes }); return;
      } else if (p === '/api/gichul/manifest') body = brokenContent ? {} : manifest;
      else if (p.startsWith('/api/gichul/pdf/')) {
        await route.fulfill({ status: failPdf ? 503 : 200, contentType: 'application/pdf', body: p.endsWith('-answer') ? answerBytes : paperBytes }); return;
      } else throw new Error('Unexpected API path: ' + p);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    } catch (error) { apiErrors.push(error.message); await route.abort(); }
  });
  await page.goto(origin + path);
  return { context, page, calls, errors, saved, failPdf: value => { failPdf = value; } };
}
const ready = { '/WordMaster/': '#dailyStartBtn', '/smstudy/': '#startSelected', '/gichul/': '#gichulMerge' };
async function assertBounds(page, name) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': no viewport overflow');
  for (const selector of ['#studyThemeToggle', '.study-route-link[aria-current]']) {
    const target = page.locator(selector);
    const box = await target.boundingBox();
    check(box && box.height >= 44 && box.width >= 44 && box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, name + ': accessible ' + selector);
    check(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), name + ': no overlay blocks ' + selector);
  }
}
const luminance = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
const colorRgb = text => text.match(/[\d.]+/g).slice(0,3).map(Number);
const contrast = (a,b) => { const x = luminance(colorRgb(a)); const y = luminance(colorRgb(b)); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
async function paletteChecks(page, name) {
  const values = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const span = document.createElement('span'); document.body.append(span);
    const out = {};
    for (const key of ['--text','--text-2','--text-3','--surface','--bg']) { span.style.color = root.getPropertyValue(key); out[key] = getComputedStyle(span).color; }
    span.remove();
    const button = document.querySelector('.btn-primary');
    const style = button ? getComputedStyle(button) : null;
    return { out, button: style ? [style.color, style.backgroundColor] : null };
  });
  for (const text of ['--text','--text-2','--text-3']) {
    for (const surface of ['--surface','--bg']) check(contrast(values.out[text],values.out[surface]) >= 4.5, `${name}: text contrast ${text}/${surface}`);
  }
  if (values.button) check(contrast(...values.button) >= 4.5, name + ': primary button contrast');
}
async function shot(page, name) {
  if (!ARTIFACTS) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS,name+'.png'), fullPage: false, animations: 'disabled' });
}
try {
  for (const path of Object.keys(ready)) {
    const f = await setup(path);
    await f.page.locator(ready[path]).waitFor({ state: 'visible' });
    check(!/데이터 로드 오류|화면 로드 오류/.test(await f.page.locator('main').innerText()), path + ': real content, not a blank/error shell');
    if (path === '/smstudy/') check(await f.page.locator('.sub-check').count() === 17, 'all 17 social-studies units render');
    if (path === '/gichul/') check(await f.page.locator('[data-pick]').count() === 2, 'actual past-paper list renders');
    for (const theme of ['light','dark']) {
      if (await f.page.locator('html').getAttribute('data-theme') !== theme) await f.page.click('#studyThemeToggle');
      await paletteChecks(f.page, path + '/' + theme);
      for (const width of [320,390,768,1024,1440]) {
        await f.page.setViewportSize({ width, height: 900 });
        await assertBounds(f.page, `${path}/${theme}/${width}`);
        if (width === 390 || width === 1440) await shot(f.page, path.replaceAll('/','')+'-'+theme+'-'+width);
      }
    }
    await f.page.reload(); await f.page.locator(ready[path]).waitFor();
    check(await f.page.locator('html').getAttribute('data-theme') === 'dark', path + ': saved theme survives reload');
    check(f.errors.length === 0, path + ': no runtime errors: ' + f.errors.join(', '));
    await f.context.close();
    console.log('PASS populated responsive themes ' + path);
  }

  // WordMaster: retain current automatic recall grading and visible answer feedback.
  const wm = await setup('/WordMaster/');
  await wm.page.locator('#dailyStartBtn').waitFor();
  await wm.page.click('#editDailyGoal');
  await wm.page.fill('#dailyGoalInput','10');
  await wm.page.locator('#dailyGoalForm button[type="submit"]').click();
  await wm.page.click('#dailyStartBtn');
  await wm.page.locator('#answerInput').waitFor();
  await wm.page.fill('#answerInput','테스트에서만 쓰는 오답');
  await wm.page.click('#submitBtn');
  await wm.page.locator('.wm-feedback.is-wrong').waitFor();
  check(await wm.page.locator('[data-recall-grade]').count() === 0, 'automatic recall grading from latest main remains intact');
  const record = await wm.page.evaluate(() => JSON.parse(localStorage.getItem('wordmaster2000.quiz.v1')));
  check(Object.keys(record.learning.cards).length === 1 && record.learning.activeSession.answered, 'answer and resume state saved');
  await shot(wm.page,'wordmaster-answer-mobile');
  await wm.page.click('#homeLogo');
  await wm.page.click('#dailyReviewBtn');
  await wm.page.locator('#startScheduledReview').waitFor();
  check(wm.errors.length === 0, 'WordMaster workflow runtime');
  await wm.context.close();

  // Real social-studies fixture: unit navigation, completion, quiz grading, note and backup.
  const sc = await setup('/smstudy/');
  await sc.page.locator('#startSelected').waitFor();
  await sc.page.locator('.list-row-stretch[data-id="I-01"]').click();
  await sc.page.locator('#markDone').waitFor();
  check(await sc.page.locator('#concept-core').isVisible(), 'concept core renders');
  await sc.page.click('#markDone');
  check(await sc.page.evaluate(() => JSON.parse(localStorage.getItem('samun2027.study.v1')).completed['I-01']), 'concept completion retained');
  await sc.page.click('#studyThemeToggle');
  await sc.page.emulateMedia({ media: 'print' });
  check(await sc.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) === '#fff', 'dark display prints using a paper palette');
  check(await sc.page.locator('.topbar').isHidden(), 'print has no navigation chrome');
  check(await sc.page.locator('#concept-core').isVisible(), 'print retains concept contents');
  await sc.page.emulateMedia({ media: 'screen' });
  await sc.page.click('#subQuiz');
  await sc.page.locator('.choice-option').first().waitFor();
  const image = sc.page.locator('img[data-question-image]').first();
  if (await image.count()) await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
  await sc.page.locator('.choice-option').first().click();
  await sc.page.locator('.sm-feedback').waitFor();
  check(await sc.page.evaluate(() => JSON.parse(localStorage.getItem('samun2027.study.v1')).attempts) === 1, 'social-studies answer counted');
  await sc.page.click('#homeLogo');
  await sc.page.locator('.sub-check').last().check();
  await sc.page.locator('.sub-check').last().scrollIntoViewIfNeeded();
  await sc.page.locator('#studyActionDock').waitFor({ state: 'visible' });
  check(await sc.page.locator('#studyQuickStart').isEnabled(), 'mobile quiz action available next to selected units');
  await sc.page.click('#studyQuickStart');
  await sc.page.locator('.choice-option').first().waitFor();
  await expect(sc.page.locator('#studyActionDock')).toBeHidden();
  sc.page.once('dialog', dialog => dialog.accept());
  await sc.page.click('#openStats');
  await sc.page.locator('#exportData').waitFor();
  const backupPromise = sc.page.waitForEvent('download');
  await sc.page.click('#exportData');
  const backup = await backupPromise;
  check(backup.suggestedFilename().endsWith('.json'), 'social-studies record export remains available');
  check(sc.errors.length === 0, 'social-studies complete workflow has no runtime errors');
  await sc.context.close();

  // Paper filters move the same live controls into a focus-trapped sheet, including tablet rotation.
  const gi = await setup('/gichul/');
  await gi.page.locator('#gichulMerge').waitFor();
  await gi.page.click('#studyFilterTrigger');
  await gi.page.locator('#studyFilterDialog').waitFor({ state: 'visible' });
  check(await gi.page.locator('#studyFilterDialog #gichulFilters').count() === 1, 'one filter DOM lives inside mobile sheet');
  await gi.page.locator('[data-option="includeAnswers"]').check();
  await gi.page.locator('.study-sheet-foot button').click();
  await expect(gi.page.locator('#studyFilterDialog')).toBeHidden();
  check(await gi.page.locator('#studyFilterTrigger').evaluate(el => document.activeElement === el), 'closing sheet restores trigger focus');
  await gi.page.locator(`[data-pick="${oldPaper.id}"]`).check();
  const fullPromise = gi.page.waitForEvent('download');
  await gi.page.click('#gichulMerge');
  const full = await fullPromise;
  const fullDoc = await PDF.load(new Uint8Array(await readFile(await full.path())));
  check(fullDoc.getPageCount() === 7, 'full paper plus answer merge preserves 7 synthetic pages');
  await gi.page.click('#studyFilterTrigger');
  await gi.page.locator('[data-option="includeAnswers"]').uncheck();
  await gi.page.keyboard.press('Escape');
  await expect(gi.page.locator('#studyFilterDialog')).toBeHidden();
  await gi.page.locator('[data-mode="excerpt"]').click();
  check(await gi.page.locator(`[data-pick="${oldPaper.id}"]`).isDisabled(), 'unsupported excerpt remains disabled');
  await gi.page.locator(`[data-pick="${newPaper.id}"]`).check();
  const excerptPromise = gi.page.waitForEvent('download');
  await gi.page.click('#gichulMerge');
  const excerpt = await excerptPromise;
  check((await PDF.load(new Uint8Array(await readFile(await excerpt.path())))).getPageCount() === 2, 'selection-only extraction preserves two pages');
  await gi.page.click('#studyFilterTrigger');
  await gi.page.setViewportSize({ width: 1024, height: 900 });
  await expect(gi.page.locator('#studyFilterDialog')).toBeHidden();
  check(await gi.page.locator('.app-shell > #gichulFilters').count() === 1, 'rotation returns filters to desktop rail without duplicate controls');
  check(!await gi.page.locator('body').evaluate(el => el.classList.contains('study-modal-open')), 'rotation releases scroll lock');
  await gi.page.setViewportSize({ width: 390, height: 900 });
  await gi.page.click('#studyFilterTrigger');
  await gi.page.locator('input[data-facet="years"][value="2021"]').check();
  await gi.page.locator('.study-sheet-foot button').click();
  check(await gi.page.locator('[data-pick]').count() === 1, 'year filter changes visible paper list');
  check(await gi.page.locator('#gichulMerge').isDisabled(), 'hidden selection cannot leak into merged PDF');
  check(gi.errors.length === 0, 'paper workflow no runtime errors');
  await gi.context.close();

  const failedDownload = await setup('/gichul/');
  await failedDownload.page.locator('#gichulMerge').waitFor();
  await failedDownload.page.locator('[data-pick="2020-csat-korean-question"]').check();
  let unintendedDownloads = 0;
  failedDownload.page.on('download', () => { unintendedDownloads++; });
  failedDownload.failPdf(true);
  await failedDownload.page.click('#gichulMerge');
  await failedDownload.page.locator('.gi-alert').waitFor();
  check(unintendedDownloads === 0, 'failed paper fetch never produces a partial PDF');
  check(await failedDownload.page.locator('#gichulMerge').isEnabled(), 'failed download permits a user retry');
  await failedDownload.context.close();

  const preferences = await setup('/WordMaster/');
  await preferences.page.locator('#dailyStartBtn').waitFor();
  await preferences.page.emulateMedia({ colorScheme: 'dark' });
  await expect(preferences.page.locator('html')).toHaveAttribute('data-theme','dark');
  await preferences.page.click('#studyThemeToggle');
  await preferences.page.emulateMedia({ colorScheme: 'light' });
  await preferences.page.emulateMedia({ colorScheme: 'dark' });
  check(await preferences.page.locator('html').getAttribute('data-theme') === 'light', 'explicit theme is not overwritten by system preference changes');
  await preferences.page.locator('.study-route-link[href="/smstudy/"]').click();
  await preferences.page.locator('#startSelected').waitFor();
  check(await preferences.page.locator('html').getAttribute('data-theme') === 'light', 'theme persists across study applications');
  check(await preferences.page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length) === 0, 'reduced motion suppresses entrance effects');
  const secondTab = await preferences.context.newPage();
  await secondTab.goto(origin+'/gichul/');
  await secondTab.locator('#gichulMerge').waitFor();
  await secondTab.click('#studyThemeToggle');
  await expect(preferences.page.locator('html')).toHaveAttribute('data-theme','dark');
  check(true,'theme follows another tab without reloading');
  await preferences.context.close();

  const bad = await setup('/smstudy/', { brokenContent: true });
  await expect.poll(() => bad.page.locator('main').innerText()).toMatch(/불러오기|로드 오류/);
  check(await bad.page.locator('#startSelected').count() === 0, 'malformed content fails instead of passing an empty-shell test');
  await bad.context.close();
  for (const path of Object.keys(ready)) {
    const anonymous = await setup(path, { loggedIn: false });
    await expect.poll(() => new URL(anonymous.page.url()).pathname).toBe('/');
    check(!anonymous.calls.some(call => /\/api\/(learning|gichul)/.test(call.path)), path + ': no anonymous content fetch');
    await anonymous.context.close();
  }
  const landing = await setup('/');
  check(!await landing.page.locator('html').evaluate(el => el.classList.contains('study-app')), 'original landing does not adopt study theme');
  check(await landing.page.locator('#studyThemeToggle').count() === 0, 'landing has no study controls');
  await landing.context.close();
  check(apiErrors.length === 0, 'no unexpected fixture request: ' + apiErrors.join('; '));
  console.log(`Study UI E2E passed (${checks} assertions; populated data, 2 themes, 5 widths, real workflows).`);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
