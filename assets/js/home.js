(() => {
  'use strict';
  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const ownerUsernames = new Set(['hvsdcm']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 드로어 아이콘은 site-icons.js(DESIGN.md §5.1)에서만 나온다. 매핑이 없으면 아이콘 없이 라벨만 그린다.
  const ICONS = window.SITE_ICONS || {};
  const elements = {
    wordmark: document.getElementById('wordmark'), drawer: document.getElementById('drawer'),
    shade: document.getElementById('shade'), closeDrawer: document.getElementById('closeDrawer'),
    drawerLogout: document.getElementById('drawerLogout'), studyLinks: document.getElementById('studyLinks'),
    ownerLinks: document.getElementById('ownerLinks'),
    modal: document.getElementById('loginModal'), loginForm: document.getElementById('loginForm'),
    closeLogin: document.getElementById('closeLogin'), loginError: document.getElementById('loginError'),
    username: document.getElementById('username'), password: document.getElementById('password'),
  };
  const token = localStorage.getItem('hvsdcm.token');
  const savedUsername = localStorage.getItem('hvsdcm.user');
  const signedIn = Boolean(token && savedUsername);
  let opener = null;

  function setDrawer(open) {
    elements.drawer.classList.toggle('open', open);
    elements.shade.classList.toggle('open', open);
    elements.drawer.setAttribute('aria-hidden', String(!open));
    elements.shade.setAttribute('aria-hidden', String(!open));
  }
  function setBackgroundInert(inert) {
    for (const child of document.body.children) if (child !== elements.modal && child.tagName !== 'SCRIPT') child.inert = inert;
  }
  function openLogin() {
    opener = document.activeElement;
    setDrawer(false);
    elements.loginError.textContent = '';
    setBackgroundInert(true);
    elements.modal.classList.add('open');
    elements.modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => elements.username.focus());
  }
  function closeLogin() {
    if (!elements.modal.classList.contains('open')) return;
    elements.modal.classList.remove('open');
    elements.modal.setAttribute('aria-hidden', 'true');
    setBackgroundInert(false);
    requestAnimationFrame(() => opener?.focus());
  }
  function trapLoginFocus(event) {
    if (event.key !== 'Tab' || !elements.modal.classList.contains('open')) return;
    const controls = [...elements.loginForm.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((control) => !control.disabled && control.offsetParent !== null);
    if (!controls.length) return;
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function safeNextPath() {
    const candidate = new URLSearchParams(location.search).get('next');
    if (!candidate) return null;
    try { const target = new URL(candidate, location.origin); return target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : null; } catch { return null; }
  }
  async function login(event) {
    event.preventDefault();
    elements.loginError.textContent = '';
    try {
      const response = await fetch(`${API_URL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: elements.username.value, password: elements.password.value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '로그인 실패');
      localStorage.setItem('hvsdcm.token', data.token);
      localStorage.setItem('hvsdcm.user', data.user.username);
      location.assign(safeNextPath() || '/');
    } catch (error) { elements.loginError.textContent = error.message || '로그인 실패'; }
  }
  async function logout() {
    try { await fetch(`${API_URL}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${token || ''}` } }); } catch { /* 로컬 세션은 항상 지운다. */ }
    localStorage.removeItem('hvsdcm.token'); localStorage.removeItem('hvsdcm.user'); sessionStorage.clear(); location.reload();
  }
  // 테두리형 SVG 아이콘 하나 — 스프라이트의 <use> 참조. 라벨이 항상 곁에 있으므로 aria-hidden이다(§5).
  function uiIcon(id) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `/assets/ui-icons.svg?v=20260904-icons-v2#${id}`);
    svg.append(use);
    return svg;
  }
  // 드로어 그룹 하나 = 대문자 헤드(.list-group-head) + 그룹 리스트(.list-group). 항목은 48px 행
  // [아이콘][제목][chevron]이고 항목마다 테두리·둥근 상자를 두르지 않는다(DESIGN.md §6·§7.1).
  // 헤드 문구는 마크업이 아니라 여기서 만든다 — 미로그인 index.html은 학습 어휘를 갖지 않는다.
  function appendLinks(target, heading, links) {
    const head = document.createElement('h2'); head.className = 'list-group-head'; head.textContent = heading;
    const group = document.createElement('div'); group.className = 'list-group';
    for (const [href, title, iconKey] of links) {
      const anchor = document.createElement('a'); anchor.className = 'list-row list-row-nav'; anchor.href = href;
      const iconId = ICONS[iconKey];
      if (iconId) {
        const lead = document.createElement('span'); lead.className = 'list-row-lead'; lead.append(uiIcon(iconId));
        anchor.append(lead);
      }
      const body = document.createElement('span'); body.className = 'list-row-body';
      const label = document.createElement('span'); label.className = 'list-row-title'; label.textContent = title;
      body.append(label); anchor.append(body); group.append(anchor);
    }
    target.append(head, group);
  }
  function mountSignedInLinks() {
    appendLinks(elements.studyLinks, '학습', [
      ['/WordMaster/', 'WordMaster', 'WordMaster'],
      ['/smstudy/', '사회·문화', 'smstudy'],
      ['/plstudy/', '정치와 법', 'plstudy'],
      ['/gichul/', '기출', 'gichul'],
    ]);
    if (!ownerUsernames.has(String(savedUsername).toLowerCase())) return;
    appendLinks(elements.ownerLinks, '운영', [
      ['/behavior-lab/#paper', 'Behavior Lab', 'behaviorLab'],
      ['/usage/', '공모전', 'usage'],
      ['/admin/', '관리자', 'admin'],
    ]);
  }

  elements.wordmark.addEventListener('click', () => signedIn ? setDrawer(true) : openLogin());
  elements.closeDrawer.addEventListener('click', () => setDrawer(false));
  elements.shade.addEventListener('click', () => setDrawer(false));
  elements.drawerLogout.addEventListener('click', logout);
  elements.closeLogin.addEventListener('click', closeLogin);
  elements.loginForm.addEventListener('submit', login);
  elements.modal.addEventListener('click', (event) => { if (event.target === elements.modal) closeLogin(); });
  document.addEventListener('keydown', (event) => { trapLoginFocus(event); if (event.key === 'Escape') { setDrawer(false); closeLogin(); } });
  if (signedIn) mountSignedInLinks();
  if (new URLSearchParams(location.search).get('login') === '1' && !signedIn) openLogin();
})();
