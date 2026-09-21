(() => {
  'use strict';
  const STORAGE_KEY = 'hvsdcm.study.theme.v1';
  const root = document.documentElement;
  const body = document.body;
  if (!body?.classList.contains('study-toss')) return;

  const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const saved = () => {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch { return null; }
  };
  const setTheme = (theme, persist = false) => {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#f2f4f6');
    const toggle = document.getElementById('studyThemeToggle');
    if (toggle) {
      toggle.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
      toggle.setAttribute('title', theme === 'dark' ? '라이트 모드' : '다크 모드');
    }
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* theme persistence is optional */ }
    }
  };

  setTheme(saved() || (systemDark() ? 'dark' : 'light'));

  const nav = document.querySelector('.topbar-nav');
  if (nav && !document.getElementById('studyThemeToggle')) {
    const button = document.createElement('button');
    button.id = 'studyThemeToggle';
    button.className = 'study-theme-toggle';
    button.type = 'button';
    button.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-eye"></use></svg>';
    button.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
    nav.append(button);
    setTheme(root.dataset.theme || 'light');
  }

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', (event) => {
    if (!saved()) setTheme(event.matches ? 'dark' : 'light');
  });
})();
