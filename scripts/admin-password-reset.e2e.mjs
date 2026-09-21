import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Browser regressions use only a loopback static server and intercepted fixture API calls.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const artifactDir = process.env.ADMIN_PASSWORD_RESET_E2E_ARTIFACT_DIR;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = resolve(ROOT, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (!filename.startsWith(`${resolve(ROOT)}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(filename);
    response.writeHead(200, { 'content-type': mime[extname(filename)] || 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

async function matchingPasswords(page, password = 'Browser-fixture-password!') {
  await page.locator('#resetPassword').fill(password);
  await page.locator('#resetPasswordConfirm').fill(password);
}

try {
  browser = await chromium.launch({ headless: true });
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`${origin}/admin/`);
  await expect(anonymousPage.locator('#login')).toBeVisible();
  await expect(anonymousPage.locator('#adminShell')).toBeHidden();
  await expect(anonymousPage.locator('#passwordResetDialog')).toBeHidden();
  await anonymous.close();
  console.log('PASS admin password reset: logged-out interface stays gated');

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript(() => {
        localStorage.setItem('hvsdcm.api', location.origin);
        sessionStorage.setItem('hvsdcm.admin', 'admin-e2e-token');
      });
      const state = { resets: [], resetStatus: 200, badAck: false, failRefresh: false, hold: false, release: null };
      await context.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const respond = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (request.headers().authorization !== 'Bearer admin-e2e-token') {
          return respond(401, { error: '관리자 로그인이 필요합니다.' });
        }
        if (/^\/api\/admin\/users\/\d+\/password$/.test(path)) {
          assert.equal(request.method(), 'POST');
          state.resets.push({ path, body: request.postDataJSON() });
          if (state.hold) await new Promise((done) => { state.release = done; });
          return respond(state.resetStatus, state.resetStatus === 200 ? (state.badAck ? {} : { ok: true })
            : { error: state.resetStatus === 401 ? '관리자 로그인이 필요합니다.' : '비밀번호 초기화에 실패했습니다.' });
        }
        if (state.failRefresh) return respond(503, { error: 'Fixture refresh failure' });
        if (path === '/api/admin/users') return respond(200, { users: [
          { id: 1, username: 'reset-student', created_at: 1_780_000_000_000, active_devices: 2,
            logins: 4, word_events: 6, sm_events: 0, pl_events: 0 },
          { id: 2, username: '<img id="injected-reset-name" src=x>', created_at: 1_780_000_000_000,
            active_devices: 0, logins: 0, word_events: 0, sm_events: 0, pl_events: 0 },
        ] });
        if (path === '/api/admin/stats') return respond(200, {
          totals: { users: 2, active_sessions: 2, events_24h: 0, known_ips_30d: 0, shared_answers: 0 },
        });
        if (path === '/api/admin/sessions') return respond(200, { sessions: [] });
        if (path === '/api/admin/answers') return respond(200, { answers: [] });
        return respond(404, { error: 'Unexpected fixture endpoint' });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/admin/`);
      await expect(page.locator('#adminShell')).toBeVisible();
      await page.locator('.sidebar-item[data-view="users"]').click();
      const resetButton = page.locator('.reset-password[data-id="1"]');
      const dialog = page.locator('#passwordResetDialog');
      const submit = page.locator('#passwordResetSubmit');
      const resetError = page.locator('#passwordResetError');
      await resetButton.click();
      await expect(dialog).toBeVisible();
      await expect(page.locator('#resetPassword')).toBeFocused();
      await expect(page.locator('#passwordResetUsername')).toHaveText('reset-student');
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds.height <= viewport.height);
      assert.equal(await page.locator('#injected-reset-name').count(), 0);

      await matchingPasswords(page);
      await page.locator('#resetPasswordConfirm').fill('Different-fixture-password!');
      await submit.click();
      await expect(resetError).toContainText('일치하지 않습니다');
      assert.equal(state.resets.length, 0);
      await expect(page.locator('#resetPasswordConfirm')).toBeFocused();
      await page.locator('#resetPasswordShow').check();
      await expect(page.locator('#resetPassword')).toHaveAttribute('type', 'text');
      await page.locator('#passwordResetCancel').click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#resetPassword')).toHaveValue('');
      await expect(page.locator('#resetPasswordConfirm')).toHaveValue('');
      await expect(resetButton).toBeFocused();

      await resetButton.click();
      await expect(page.locator('#resetPassword')).toHaveAttribute('type', 'password');
      await expect(page.locator('#resetPasswordShow')).not.toBeChecked();
      await matchingPasswords(page, '      ');
      await submit.click();
      await expect(resetError).toContainText('공백만');
      assert.equal(state.resets.length, 0);
      await matchingPasswords(page);
      for (const status of [401, 500]) {
        state.resetStatus = status;
        await submit.click();
        await expect(resetError).toContainText(status === 401 ? '관리자 로그인이 필요합니다' : '초기화에 실패');
        await expect(submit).toBeEnabled();
        await expect(dialog).toBeVisible();
        await expect(page.locator('#userStatus')).toBeEmpty();
      }

      state.resetStatus = 200;
      state.badAck = true;
      await submit.click();
      await expect(resetError).toContainText('초기화 결과를 확인하지 못했습니다');
      await expect(dialog).toBeVisible();
      await expect(submit).toBeEnabled();
      await expect(page.locator('#userStatus')).toBeEmpty();
      state.badAck = false;
      state.hold = true;
      const countBefore = state.resets.length;
      await submit.click();
      await expect(submit).toBeDisabled();
      await expect(page.locator('#passwordResetCancel')).toBeDisabled();
      await expect.poll(() => state.resets.length).toBe(countBefore + 1);
      await page.locator('#passwordResetForm').evaluate((form) => form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      assert.equal(state.resets.length, countBefore + 1, 'duplicate submits must not produce a second request');
      await expect.poll(() => typeof state.release).toBe('function');
      state.hold = false;
      state.release();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#userStatus')).toContainText('reset-student 계정의 비밀번호를 초기화했습니다');
      await expect(page.locator('#passwordResetForm')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#resetPassword')).toHaveValue('');
      await expect(page.locator('#resetPasswordConfirm')).toHaveValue('');
      await expect(resetButton).toBeFocused();
      assert.deepEqual(state.resets.at(-1), {
        path: '/api/admin/users/1/password', body: { password: 'Browser-fixture-password!' },
      });
      const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      assert.ok(!storage.includes('Browser-fixture-password!'), 'password must never enter browser storage');

      await resetButton.click();
      await matchingPasswords(page);
      state.failRefresh = true;
      await submit.click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#userStatus')).toContainText('초기화했습니다');
      await expect(page.locator('#userError')).toContainText('비밀번호는 변경되었습니다');
      await expect(page.locator('#passwordResetForm')).toHaveAttribute('aria-busy', 'false');
      state.failRefresh = false;

      await page.locator('.reset-password[data-id="2"]').click();
      await expect(page.locator('#passwordResetUsername')).toHaveText('<img id="injected-reset-name" src=x>');
      assert.equal(await page.locator('#injected-reset-name').count(), 0);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await resetButton.click();
      await expect(page.locator('#passwordResetUsername')).toHaveText('reset-student');
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({ path: resolve(artifactDir, `password-reset-${viewport.width}.png`), fullPage: true });
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      assert.deepEqual(errors, []);
      console.log(`PASS admin password reset ${viewport.width}px: confirmation, validation, cancel, errors, single-submit, focus, success and privacy`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
