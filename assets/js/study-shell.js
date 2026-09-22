(() => {
  'use strict';
  const root = document.documentElement;
  if (!root.classList.contains('study-app')) return;
  const KEY = 'hvsdcm.study.theme.v1';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const small = window.matchMedia('(max-width: 860px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const readTheme = () => {
    try { const theme = localStorage.getItem(KEY); return ['light', 'dark'].includes(theme) ? theme : null; }
    catch { return null; }
  };
  function applyTheme(theme, persist = false) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101318' : '#f2f4f6');
    const button = document.getElementById('studyThemeToggle');
    if (button) {
      const label = theme === 'dark' ? '라이트 모드' : '다크 모드';
      button.setAttribute('aria-label', label + '로 전환');
      button.setAttribute('title', label + '로 전환');
      button.querySelector('span').textContent = label;
    }
    if (persist) { try { localStorage.setItem(KEY, theme); } catch { /* Theme still works without storage. */ } }
  }
  // This script runs in the head: restore the palette before any page surface is painted.
  applyTheme(readTheme() || (media.matches ? 'dark' : 'light'));
  media.addEventListener('change', () => { if (!readTheme()) applyTheme(media.matches ? 'dark' : 'light'); });
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) applyTheme(readTheme() || (media.matches ? 'dark' : 'light'));
  });

  function mount() {
    const button = document.getElementById('studyThemeToggle');
    button?.addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
    applyTheme(root.dataset.theme);
    const main = document.getElementById('app');
    const body = document.body;
    const filters = document.getElementById('gichulFilters');
    const dialog = document.getElementById('studyFilterDialog');
    const trigger = document.getElementById('studyFilterTrigger');
    let filterHome;
    let placeholder;
    if (filters && dialog && trigger) {
      filterHome = filters.parentNode;
      placeholder = document.createComment('desktop filter position');
      filters.before(placeholder);
      const panel = document.getElementById('studyFilterContent');
      const unlock = () => {
        body.classList.remove('study-modal-open');
        trigger.setAttribute('aria-expanded', 'false');
        if (small.matches) trigger.focus({ preventScroll: true });
      };
      dialog.addEventListener('close', unlock);
      trigger.addEventListener('click', () => {
        if (!small.matches) return;
        dialog.showModal();
        body.classList.add('study-modal-open');
        trigger.setAttribute('aria-expanded', 'true');
      });
      dialog.querySelectorAll('[data-close-filters]').forEach(control => control.addEventListener('click', () => dialog.close()));
      dialog.addEventListener('click', event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
      });
      const placeFilters = () => {
        if (small.matches) {
          panel.append(filters);
          filters.querySelectorAll('details.gi-filter').forEach(detail => { detail.open = true; });
        } else {
          if (dialog.open) dialog.close();
          filterHome.insertBefore(filters, placeholder.nextSibling);
          body.classList.remove('study-modal-open');
          filters.querySelectorAll('details.gi-filter').forEach(detail => { detail.open = true; });
        }
      };
      small.addEventListener('change', placeFilters);
      placeFilters();
    }

    // A small-screen action mirrors the existing quiz button, never a second quiz state.
    const dock = document.getElementById('studyActionDock');
    const dockButton = document.getElementById('studyQuickStart');
    let watchedButton = null;
    let primaryVisible = true;
    const updateDock = () => {
      if (!dock || !dockButton) return;
      const action = document.getElementById('startSelected');
      const show = small.matches && action && !action.disabled && !primaryVisible;
      dock.hidden = !show;
      dockButton.disabled = !action || action.disabled;
      if (action) dockButton.textContent = action.textContent.trim();
    };
    const intersection = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      primaryVisible = entries[0]?.isIntersecting || false;
      updateDock();
    }) : null;
    dockButton?.addEventListener('click', () => document.getElementById('startSelected')?.click());
    small.addEventListener('change', updateDock);
    let lastView = '';
    let animation;
    let frame = 0;
    const syncScreen = () => {
      frame = 0;
      const action = document.getElementById('startSelected');
      if (action !== watchedButton) {
        intersection?.disconnect();
        watchedButton = action;
        primaryVisible = true;
        if (action) intersection?.observe(action);
      }
      updateDock();
      // Identical data refreshes must not repeatedly flash or shift the dashboard.
      const target = main?.querySelector('.wm-word-line, .sm-question-head, .view-head-main, .sm-concept-head');
      const key = (main?.querySelector('h1')?.textContent || '') + '|' + (main?.querySelector('.wm-word, .sm-qnum')?.textContent || '');
      if (key && key !== lastView) {
        lastView = key;
        animation?.cancel();
        if (!reduced.matches && target?.animate) {
          animation = target.animate([{ opacity: 0.6, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.3,1)' });
        }
      }
    };
    if (main) new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(syncScreen); }).observe(main, { childList: true, subtree: true });
    reduced.addEventListener('change', () => { if (reduced.matches) animation?.cancel(); });
    syncScreen();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
