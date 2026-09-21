(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  let adminToken = sessionStorage.getItem('hvsdcm.admin') || '';

  const elements = {
    addUserForm: document.getElementById('addUser'),
    adminLoginForm: document.getElementById('adminLogin'),
    adminLogout: document.getElementById('adminLogout'),
    adminPassword: document.getElementById('adminPassword'),
    answers: document.getElementById('answers'),
    login: document.getElementById('login'),
    loginError: document.getElementById('loginError'),
    main: document.getElementById('adminMain'),
    newPassword: document.getElementById('newPassword'),
    newUsername: document.getElementById('newUsername'),
    overviewNav: document.getElementById('overviewNav'),
    panel: document.getElementById('panel'),
    refresh: document.getElementById('refresh'),
    passwordResetDialog: document.getElementById('passwordResetDialog'),
    passwordResetForm: document.getElementById('passwordResetForm'),
    passwordResetUsername: document.getElementById('passwordResetUsername'),
    passwordResetError: document.getElementById('passwordResetError'),
    passwordResetCancel: document.getElementById('passwordResetCancel'),
    passwordResetSubmit: document.getElementById('passwordResetSubmit'),
    resetPassword: document.getElementById('resetPassword'),
    resetPasswordConfirm: document.getElementById('resetPasswordConfirm'),
    resetPasswordShow: document.getElementById('resetPasswordShow'),
    userStatus: document.getElementById('userStatus'),
    sessionCount: document.getElementById('sessionCount'),
    sessions: document.getElementById('sessions'),
    sessionUserFilter: document.getElementById('sessionUserFilter'),
    shell: document.getElementById('adminShell'),
    stats: document.getElementById('stats'),
    userError: document.getElementById('userError'),
    users: document.getElementById('users'),
    viewSub: document.getElementById('viewSub'),
    viewTitle: document.getElementById('viewTitle'),
  };
  let sessionRows = [];
  let passwordResetTarget = null;
  let passwordResetPending = false;
  const appLabels = {
    wordmaster: '영단어',
    smstudy: '사회문화',
    plstudy: '정치와 법',
  };

  // ---- 카테고리 뷰 전환 ------------------------------------------------------
  // 뷰 목록을 JS에 다시 적지 않는다 — 사이드바 버튼과 뷰 컨테이너의 data-view가 원본이고,
  // 여기서는 그 둘을 이름으로 짝짓는다. 사이드바에 항목을 추가하면 뷰도 따라온다.
  const navButtons = [...document.querySelectorAll('.sidebar-item[data-view]')];
  const views = [...document.querySelectorAll('.ad-view[data-view]')];
  // 항목 라벨은 텍스트 슬롯(.sidebar-item-text)에서만 읽는다 — button.textContent에는
  // 아이콘 SVG 주변 공백이 섞일 수 있다.
  const labelOf = (button) => (button.querySelector('.sidebar-item-text') || button).textContent.trim();
  const DEFAULT_VIEW = navButtons[0]?.dataset.view || '';
  let currentView = DEFAULT_VIEW;

  function setView(name) {
    const target = navButtons.some((button) => button.dataset.view === name) ? name : DEFAULT_VIEW;
    currentView = target;
    for (const view of views) view.hidden = view.dataset.view !== target;
    for (const button of navButtons) {
      if (button.dataset.view === target) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      // 뷰 제목은 사이드바 라벨에서 가져온다 — 같은 문구를 두 곳에 적지 않기 위해서다.
      if (button.dataset.view !== target) continue;
      elements.viewTitle.textContent = labelOf(button);
      elements.viewSub.textContent = button.dataset.sub || '';
    }
  }

  const escapeHtml = (value) => String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character],
  );

  // 표는 시각 열이 6개다. ko-KR 로케일 문자열("2026. 8. 26. 오후 3:24:15")은 열마다
  // 20자를 넘겨 표 전체를 가로로 밀어냈다. 정렬 가능한 고정폭 표기로 줄인다.
  const pad2 = (value) => String(value).padStart(2, '0');
  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const at = new Date(timestamp);
    if (Number.isNaN(at.getTime())) return '-';
    return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  };

  function describeUserAgent(userAgent) {
    const value = String(userAgent || '');
    let os = '알 수 없는 OS';
    let browser = '알 수 없는 브라우저';
    let device = /Mobile|Android|iPhone|iPod/i.test(value) ? '모바일' : 'PC';

    if (/iPad/i.test(value)) device = '태블릿';
    if (/Windows NT/i.test(value)) os = 'Windows';
    else if (/Android/i.test(value)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(value)) os = 'iOS/iPadOS';
    else if (/Mac OS X|Macintosh/i.test(value)) os = 'macOS';
    else if (/Linux/i.test(value)) os = 'Linux';

    if (/Edg\//i.test(value)) browser = 'Edge';
    else if (/SamsungBrowser\//i.test(value)) browser = 'Samsung Internet';
    else if (/OPR\//i.test(value)) browser = 'Opera';
    else if (/CriOS|Chrome\//i.test(value)) browser = 'Chrome';
    else if (/FxiOS|Firefox\//i.test(value)) browser = 'Firefox';
    else if (/Safari\//i.test(value)) browser = 'Safari';

    return { browser, device: `${device} · ${os}` };
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '요청 실패');
    return data;
  }

  // 상태 요약 스트립 — 가로 1카드 N칸 (plan.md §3.4). 칸마다 회색 소라벨 위, 큰 값 아래.
  // 설명 줄은 없앴다: 다섯 칸에 한 줄씩 붙은 설명이 요약을 본문만큼 키웠다.
  function renderStats(totals) {
    const cells = [
      ['사용자', totals.users],
      ['활성 세션', totals.active_sessions],
      ['24시간 이벤트', totals.events_24h],
      ['30일 IP', totals.known_ips_30d],
      ['공용 답안', totals.shared_answers],
    ];

    elements.stats.innerHTML = cells.map(([label, value]) => `
      <div class="summary-cell">
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-value">${Number(value).toLocaleString()}</span>
      </div>
    `).join('');
  }

  // 개요에서 다른 뷰로 넘어가는 행. 라벨은 사이드바 버튼에서 그대로 읽는다.
  function renderOverviewNav(counts) {
    elements.overviewNav.innerHTML = navButtons
      .filter((button) => button.dataset.view !== DEFAULT_VIEW)
      .map((button) => {
        const view = button.dataset.view;
        const count = counts[view];
        return `
          <button type="button" class="list-row list-row-nav" data-goto="${escapeHtml(view)}">
            <span class="list-row-body">
              <span class="list-row-title">${escapeHtml(labelOf(button))}</span>
              <span class="list-row-sub">${escapeHtml(button.dataset.sub || '')}</span>
            </span>
            <span class="list-row-value">${count === undefined ? '-' : Number(count).toLocaleString()}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderUsers(users) {
    elements.users.innerHTML = users.map((user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${formatDate(user.created_at)}</td>
        <td>${formatDate(user.last_login_at)}</td>
        <td>${formatDate(user.last_activity_at)}</td>
        <td class="ad-n">${Number(user.active_devices).toLocaleString()}</td>
        <td class="ad-ip">${escapeHtml(user.recent_ip || '-')}</td>
        <td class="ad-n">${Number(user.logins).toLocaleString()}</td>
        <td class="ad-n">${Number(user.word_events).toLocaleString()}</td>
        <td class="ad-n">${Number(user.sm_events).toLocaleString()}</td>
        <td class="ad-n">${Number(user.pl_events).toLocaleString()}</td>
        <td>
          <div class="ad-row-actions">
            <button type="button" class="btn btn-secondary btn-sm view-sessions" data-id="${Number(user.id)}">접속</button>
            <button type="button" class="btn btn-secondary btn-sm reset-password" data-id="${Number(user.id)}" data-name="${escapeHtml(user.username)}" aria-label="${escapeHtml(user.username)} 비밀번호 초기화">비밀번호 초기화</button>
            <button
              type="button"
              class="btn btn-danger btn-sm delete-user"
              data-id="${Number(user.id)}"
              data-name="${escapeHtml(user.username)}"
            >삭제</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderSessionFilter(users) {
    const previousValue = elements.sessionUserFilter.value;
    elements.sessionUserFilter.innerHTML = [
      '<option value="all">전체 사용자</option>',
      ...users.map((user) => `<option value="${Number(user.id)}">${escapeHtml(user.username)}</option>`),
    ].join('');
    if ([...elements.sessionUserFilter.options].some((option) => option.value === previousValue)) {
      elements.sessionUserFilter.value = previousValue;
    }
  }

  function renderSessions() {
    const selectedUserId = elements.sessionUserFilter.value;
    const filtered = selectedUserId === 'all'
      ? sessionRows
      : sessionRows.filter((session) => String(session.user_id) === selectedUserId);
    const activeCount = filtered.filter((session) => session.active).length;
    elements.sessionCount.textContent = `${filtered.length.toLocaleString()}개 세션 · 활성 ${activeCount.toLocaleString()}개`;

    if (filtered.length === 0) {
      elements.sessions.innerHTML = '<tr><td colspan="8" class="ad-empty">조건에 맞는 접속 기록이 없습니다.</td></tr>';
      return;
    }

    elements.sessions.innerHTML = filtered.map((session) => {
      const userAgent = describeUserAgent(session.user_agent);
      const ip = session.ip_address && session.ip_address !== 'unknown'
        ? session.ip_address
        : session.ip_fingerprint
          ? `기존 해시 ${session.ip_fingerprint}`
          : '-';
      return `
        <tr>
          <td><span class="badge ${session.active ? 'badge-green' : ''}">${session.active ? '활성' : '만료'}</span></td>
          <td>${escapeHtml(session.username)}</td>
          <td><div class="ad-device"><strong>${escapeHtml(userAgent.device)}</strong><small title="${escapeHtml(session.user_agent || '')}">${escapeHtml(session.user_agent || 'User-Agent 없음')}</small></div></td>
          <td>${escapeHtml(userAgent.browser)}</td>
          <td class="ad-ip">${escapeHtml(ip)}</td>
          <td>${formatDate(session.created_at)}</td>
          <td>${formatDate(session.last_seen_at)}</td>
          <td>${formatDate(session.expires_at)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderAnswers(answers) {
    if (answers.length === 0) {
      elements.answers.innerHTML = '<tr><td colspan="6" class="ad-empty">아직 추가된 공용 답안이 없습니다.</td></tr>';
      return;
    }

    elements.answers.innerHTML = answers.map((answer) => `
      <tr>
        <td>${escapeHtml(appLabels[answer.app] || answer.app || '알 수 없음')}</td>
        <td>${escapeHtml(answer.question_label || answer.question_id)}</td>
        <td>${escapeHtml(answer.username || '삭제된 사용자')}</td>
        <td>${escapeHtml(answer.base_answer || '-')}</td>
        <td>${escapeHtml(answer.display_answer)}</td>
        <td>${formatDate(answer.created_at)}</td>
      </tr>
    `).join('');
  }

  async function loadDashboard() {
    const [userData, statsData, answerData, sessionData] = await Promise.all([
      request('/api/admin/users'),
      request('/api/admin/stats'),
      request('/api/admin/answers'),
      request('/api/admin/sessions'),
    ]);

    // 게이트 뒤집기(v14): 로그인 카드를 접고 그제서야 셸(사이드바 + 본문)을 연다.
    elements.login.hidden = true;
    elements.shell.hidden = false;
    renderStats(statsData.totals);
    renderUsers(userData.users);
    sessionRows = sessionData.sessions;
    renderSessionFilter(userData.users);
    renderSessions();
    renderAnswers(answerData.answers);
    renderOverviewNav({
      users: userData.users.length,
      sessions: sessionRows.length,
      answers: answerData.answers.length,
    });
    // 새로고침이 보고 있던 뷰를 벗어나지 않게 현재 뷰를 그대로 다시 세운다.
    setView(currentView);
  }

  elements.adminLoginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.loginError.textContent = '';
    try {
      const data = await request('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: elements.adminPassword.value }),
      });
      adminToken = data.token;
      sessionStorage.setItem('hvsdcm.admin', adminToken);
      await loadDashboard();
    } catch (error) {
      elements.loginError.textContent = error.message || '로그인 실패';
    }
  });

  elements.addUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.userError.textContent = '';
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: elements.newUsername.value,
          password: elements.newPassword.value,
        }),
      });
      elements.addUserForm.reset();
      await loadDashboard();
    } catch (error) {
      elements.userError.textContent = error.message || '사용자 생성 실패';
    }
  });

  elements.users.addEventListener('click', async (event) => {
    const resetButton = event.target.closest('.reset-password');
    if (resetButton) {
      if (passwordResetPending || !/^[1-9]\d*$/.test(resetButton.dataset.id)) return;
      elements.passwordResetForm.reset();
      elements.resetPassword.type = 'password';
      elements.resetPasswordConfirm.type = 'password';
      elements.passwordResetError.textContent = '';
      elements.userError.textContent = '';
      elements.userStatus.textContent = '';
      passwordResetTarget = { id: resetButton.dataset.id, name: resetButton.dataset.name };
      elements.passwordResetUsername.textContent = passwordResetTarget.name;
      elements.passwordResetDialog.showModal();
      elements.resetPassword.focus();
      return;
    }
    const sessionButton = event.target.closest('.view-sessions');
    if (sessionButton) {
      elements.sessionUserFilter.value = sessionButton.dataset.id;
      renderSessions();
      setView('sessions');
      return;
    }

    const button = event.target.closest('.delete-user');
    if (!button) return;

    const { id, name } = button.dataset;
    if (!/^\d+$/.test(id) || !confirm(`${name} 계정과 모든 학습 기록을 삭제할까요?`)) return;

    button.disabled = true;
    elements.userError.textContent = '';
    try {
      await request(`/api/admin/users/${id}`, { method: 'DELETE' });
      await loadDashboard();
    } catch (error) {
      button.disabled = false;
      elements.userError.textContent = `삭제 실패: ${error.message}`;
    }
  });

  function setPasswordResetPending(pending) {
    passwordResetPending = pending;
    elements.passwordResetForm.setAttribute('aria-busy', String(pending));
    for (const control of elements.passwordResetForm.elements) control.disabled = pending;
    elements.passwordResetSubmit.textContent = pending ? '초기화 중…' : '초기화하기';
  }

  elements.passwordResetCancel.addEventListener('click', () => {
    if (!passwordResetPending) elements.passwordResetDialog.close();
  });
  elements.passwordResetDialog.addEventListener('cancel', (event) => {
    if (passwordResetPending) event.preventDefault();
  });
  elements.passwordResetDialog.addEventListener('close', () => {
    elements.passwordResetForm.reset();
    elements.resetPassword.type = 'password';
    elements.resetPasswordConfirm.type = 'password';
    elements.passwordResetError.textContent = '';
    elements.passwordResetUsername.textContent = '';
    passwordResetTarget = null;
  });
  elements.resetPasswordShow.addEventListener('change', () => {
    const type = elements.resetPasswordShow.checked ? 'text' : 'password';
    elements.resetPassword.type = type;
    elements.resetPasswordConfirm.type = type;
  });
  elements.passwordResetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (passwordResetPending || !passwordResetTarget) return;
    elements.passwordResetError.textContent = '';
    if (!elements.passwordResetForm.reportValidity()) return;
    if (!elements.resetPassword.value.trim()) {
      elements.passwordResetError.textContent = '공백만으로 된 비밀번호는 사용할 수 없습니다.';
      elements.resetPassword.focus();
      return;
    }
    if (elements.resetPassword.value !== elements.resetPasswordConfirm.value) {
      elements.passwordResetError.textContent = '비밀번호가 서로 일치하지 않습니다.';
      elements.resetPasswordConfirm.focus();
      return;
    }
    const target = passwordResetTarget;
    setPasswordResetPending(true);
    try {
      const result = await request(`/api/admin/users/${target.id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: elements.resetPassword.value }),
        signal: AbortSignal.timeout(20_000),
      });
      if (result.ok !== true) {
        throw new Error('초기화 결과를 확인하지 못했습니다. 변경되었을 수 있으니 로그인 상태를 확인해 주세요.');
      }
    } catch (error) {
      elements.passwordResetError.textContent = error.name === 'TimeoutError' || error instanceof TypeError
        ? '서버 응답을 확인하지 못했습니다. 변경되었을 수 있으니 로그인 상태를 확인한 뒤 다시 시도해 주세요.'
        : error.message || '비밀번호 초기화에 실패했습니다.';
      setPasswordResetPending(false);
      return;
    }
    // A successful mutation stays successful even if refreshing the dashboard later fails.
    elements.passwordResetForm.reset();
    elements.passwordResetDialog.close();
    elements.userStatus.textContent = `${target.name} 계정의 비밀번호를 초기화했습니다. 기존 로그인은 만료되었으며 학습 기록은 유지됩니다.`;
    try {
      await loadDashboard();
    } catch {
      elements.userError.textContent = '비밀번호는 변경되었습니다. 목록을 불러오지 못했으니 새로고침해 주세요.';
    } finally {
      setPasswordResetPending(false);
      elements.users.querySelector(`.reset-password[data-id="${target.id}"]`)?.focus();
    }
  });

  elements.sessionUserFilter.addEventListener('change', renderSessions);

  for (const button of navButtons) {
    button.addEventListener('click', () => {
      setView(button.dataset.view);
      elements.main.focus();
    });
  }

  elements.overviewNav.addEventListener('click', (event) => {
    const row = event.target.closest('[data-goto]');
    if (!row) return;
    setView(row.dataset.goto);
    elements.main.focus();
  });

  elements.refresh.addEventListener('click', async () => {
    elements.refresh.disabled = true;
    try {
      await loadDashboard();
    } catch (error) {
      elements.userError.textContent = error.message || '새로고침 실패';
    } finally {
      elements.refresh.disabled = false;
    }
  });

  elements.adminLogout.addEventListener('click', () => {
    adminToken = '';
    sessionStorage.removeItem('hvsdcm.admin');
    location.reload();
  });

  setView(DEFAULT_VIEW);

  if (adminToken) {
    loadDashboard().catch(() => {
      adminToken = '';
      sessionStorage.removeItem('hvsdcm.admin');
      elements.adminPassword.focus();
    });
  } else {
    elements.adminPassword.focus();
  }
})();
