(() => {
  'use strict';
  // This dialog only calls the authenticated administrator API. It stores no credentials.
  globalThis.HvsPasswordDialog = {
    create(request, refresh) {
      const dialog = document.getElementById('userPasswordDialog');
      const form = document.getElementById('userPasswordForm');
      const password = document.getElementById('resetNewPassword');
      const repeat = document.getElementById('resetConfirmPassword');
      const error = document.getElementById('resetPasswordError');
      const submit = document.getElementById('submitPasswordReset');
      const cancel = document.getElementById('cancelPasswordReset');
      let id = null;
      let busy = false;
      cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
      dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
      dialog.addEventListener('close', () => { form.reset(); id = null; error.textContent = ''; });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy || !id || !form.reportValidity()) return;
        if (password.value !== repeat.value) { error.textContent = '비밀번호 확인이 일치하지 않습니다.'; repeat.focus(); return; }
        busy = true; submit.disabled = true; cancel.disabled = true; error.textContent = '';
        try {
          await request(`/api/admin/users/${id}/reset-password`, {
            method: 'POST', body: JSON.stringify({ password: password.value, confirmPassword: repeat.value }),
          });
          form.reset(); busy = false; dialog.close();
          const status = document.getElementById('userResetStatus');
          status.textContent = '비밀번호를 초기화했습니다. 기존 로그인은 만료되었고 학습 기록은 유지됩니다.';
          try { await refresh(); } catch { status.textContent += ' 목록은 새로고침해 확인해주세요.'; }
        } catch (failure) {
          error.textContent = failure.message || '초기화하지 못했습니다. 다시 시도해주세요.';
        } finally {
          busy = false; submit.disabled = false; cancel.disabled = false;
        }
      });
      return {
        open(userId, username) {
          if (busy || !/^\d+$/.test(String(userId)) || !Number.isSafeInteger(Number(userId)) || Number(userId) < 1) return;
          id = Number(userId); form.reset(); error.textContent = '';
          document.getElementById('resetUsername').textContent = String(username);
          dialog.showModal(); password.focus();
        },
      };
    },
  };
})();
