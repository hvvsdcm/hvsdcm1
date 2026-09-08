(() => {
  'use strict';
  const app = document.getElementById('app');
  const storageKey = 'politicslaw2027.study.v1';
  let data;
  let activeSub = null;
  let session = null;
  const progress = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const save = () => {
    try {
      const serialized = JSON.stringify(progress);
      localStorage.setItem(storageKey, serialized);
      window.HvsAccount?.scheduleProgressSync(serialized);
    } catch { /* 학습은 계속한다. */ }
  };
  const subunits = () => data.UNITS.flatMap((unit) => unit.subs.map((sub) => ({ ...sub, unitId: unit.id, unitTitle: unit.title })));
  const subById = (id) => subunits().find((sub) => sub.id === id);
  function setNav(view) {
    document.querySelectorAll('.pl-nav').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  // 홈 화면 중단원 검색 — 메모리에만 두는 화면 상태다. 데이터·localStorage 계약을 바꾸지 않는다.
  let homeQuery = '';
  const fold = (value) => String(value ?? '').toLowerCase().replace(/\s+/gu, '');
  const searchText = (sub) => fold([sub.unitId, sub.unitTitle, sub.id, sub.title, sub.summary, ...(sub.concepts || []).flatMap((concept) => [concept.term, concept.definition]), ...(sub.traps || [])].join('|'));
  function renderHome() {
    setNav('home'); activeSub = null; session = null;
    const rows = subunits(); const index = new Map(rows.map((sub) => [sub.id, searchText(sub)]));
    // 첫 화면 = 제목 한 줄(대표 행동 하나) → 검색 → 대단원 disclosure 6개(첫 번째만 open).
    // 중단원은 행(제목 + 우측 진행값)이고 요약문은 개념 노트로 미룬다 (DESIGN.md §6·§6.1·§7.2).
    app.innerHTML = `<header class="view-head"><div class="view-head-main"><svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-scale"></use></svg><div><h1>단원 목록</h1></div></div><button class="btn btn-primary" type="button" data-random>랜덤 20문항</button></header><section class="pl-search" aria-label="중단원 검색"><label class="sr-only" for="plSearch">중단원 검색</label><div class="pl-search-row"><input id="plSearch" class="field-input field-input-sm" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search" placeholder="단원명, 개념, 함정 검색" aria-describedby="plSearchCount" value="${esc(homeQuery)}"><button class="btn btn-secondary btn-sm pl-search-clear" type="button" data-clear hidden>지우기</button></div><span id="plSearchCount" class="pl-search-count" role="status" aria-live="polite"></span></section><div class="pl-units">${data.UNITS.map((unit, unitIndex) => { const unitRows = unit.subs.map((sub) => progress[sub.id] || {}); const unitCorrect = unitRows.reduce((sum, row) => sum + (row.correct || 0), 0); const unitAnswered = unitRows.reduce((sum, row) => sum + (row.answered || 0), 0); return `<details class="disclosure pl-unit" id="pl-unit-${unit.id}"${unitIndex === 0 ? ' open' : ''}><summary class="disclosure-head"><span class="pl-unit-num" aria-hidden="true">${unit.id}</span><span class="disclosure-title">${esc(unit.title)}</span><span class="disclosure-hint num">${unitCorrect}/${unitAnswered}</span></summary><div class="disclosure-body">${unit.subs.map((sub) => { const row = progress[sub.id] || {}; return `<button type="button" class="list-row list-row-nav pl-sub" data-sub="${sub.id}"><span class="list-row-body"><span class="list-row-title">${esc(sub.title)}</span></span><span class="list-row-value num">${row.correct || 0}/${row.answered || 0}</span></button>`; }).join('')}</div></details>`; }).join('')}</div><p class="pl-empty" hidden></p>`;
    app.querySelectorAll('[data-sub]').forEach((button) => button.addEventListener('click', () => renderConcept(button.dataset.sub)));
    app.querySelector('[data-random]').addEventListener('click', () => startQuiz([...data.QUESTIONS].sort(() => Math.random() - .5).slice(0, 20), '전체 랜덤'));
    const input = app.querySelector('#plSearch'); const count = app.querySelector('#plSearchCount'); const clear = app.querySelector('[data-clear]'); const empty = app.querySelector('.pl-empty');
    const applyFilter = () => {
      homeQuery = input.value; const query = fold(homeQuery); let shown = 0;
      app.querySelectorAll('.pl-unit').forEach((unit) => { let visible = 0; unit.querySelectorAll('.pl-sub').forEach((button) => { const hit = !query || (index.get(button.dataset.sub) || '').includes(query); button.hidden = !hit; if (hit) visible++; }); unit.hidden = visible === 0; if (query) unit.open = true; shown += visible; });
      count.textContent = query ? `일치 ${shown}개` : `중단원 ${rows.length}개`; clear.hidden = !homeQuery; empty.hidden = shown > 0;
      if (shown === 0) empty.textContent = `“${homeQuery.trim()}” 검색 결과가 없습니다.`;
    };
    const mobile = matchMedia('(max-width: 860px)');
    const units = [...app.querySelectorAll('.pl-unit')];
    units.forEach((unit) => unit.addEventListener('toggle', () => {
      if (!mobile.matches || !unit.open || fold(input.value)) return;
      units.forEach((other) => { if (other !== unit) other.open = false; });
    }));
    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape' && input.value) { input.value = ''; applyFilter(); } });
    clear.addEventListener('click', () => { input.value = ''; applyFilter(); input.focus(); });
    applyFilter();
  }
  function openUnitFromHash() {
    if (!data) return;
    const id = location.hash.slice(1);
    if (!/^pl-unit-(?:I|II|III|IV|V|VI)$/u.test(id)) return;
    let target = document.getElementById(id);
    if (!target || !app.contains(target)) {
      renderHome();
      target = document.getElementById(id);
    }
    if (!target) return;
    target.open = true;
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }
  function renderConcept(id) {
    const sub = subById(id); if (!sub) return renderHome(); activeSub = id; setNav('home');
    const questions = data.QUESTIONS.filter((question) => question.sub === id);
    const rows = subunits();
    const index = rows.findIndex((item) => item.id === id);
    app.innerHTML = `
      <nav class="pl-concept-nav" aria-label="중단원 이동">
        <button class="btn btn-ghost btn-sm" type="button" data-home>← 단원 목록</button>
        <span class="pl-position">${index + 1} / ${rows.length} 중단원</span>
        <button class="btn btn-secondary btn-sm" type="button" data-prev ${index === 0 ? 'disabled' : ''}>이전</button>
        <button class="btn btn-secondary btn-sm" type="button" data-next-sub ${index === rows.length - 1 ? 'disabled' : ''}>다음</button>
      </nav>
      <header class="view-head pl-concept-head">
        <div class="view-head-main"><div><span class="kicker">${esc(sub.unitId)} · ${esc(sub.unitTitle)}</span><h1>${esc(sub.title)}</h1><p>${esc(sub.summary)}</p></div></div>
      </header>
      <div class="pl-concept-layout">
        <section class="pl-definitions" aria-labelledby="plConcepts">
          <h2 id="plConcepts">핵심 개념</h2>
          <dl>${sub.concepts.map((concept, n) => `<div class="pl-definition"><dt><span class="pl-concept-number" aria-hidden="true">0${n + 1}</span>${esc(concept.term)}</dt><dd>${esc(concept.definition)}</dd></div>`).join('')}</dl>
        </section>
        <aside class="pl-check" aria-labelledby="plTraps">
          <h2 id="plTraps">문제 풀기 전 확인</h2>
          <ul>${sub.traps.map((trap) => `<li>${esc(trap)}</li>`).join('')}</ul>
          <button class="btn btn-primary" type="button" data-start>개념 확인 · 5문항 풀기</button>
        </aside>
      </div>`;
    app.querySelector('[data-home]').addEventListener('click', renderHome); app.querySelector('[data-start]').addEventListener('click', () => startQuiz(questions, sub.title));
    app.querySelector('[data-prev]').addEventListener('click', () => renderConcept(rows[index - 1].id));
    app.querySelector('[data-next-sub]').addEventListener('click', () => renderConcept(rows[index + 1].id));
  }
  function startQuiz(questions, label) { session = { questions, label, index: 0, correct: 0, answer: null }; renderQuiz(); }
  function choose(index) {
    if (!session || session.answer !== null) return; const question = session.questions[session.index]; session.answer = Number(index); const correct = session.answer === question.answer; if (correct) session.correct++;
    const row = progress[question.sub] || { answered: 0, correct: 0 }; row.answered++; if (correct) row.correct++; progress[question.sub] = row; save(); renderQuiz();
  }
  function next() { if (session.index === session.questions.length - 1) return renderResult(); session.index++; session.answer = null; renderQuiz(); }
  function renderQuiz() {
    setNav('home'); const question = session.questions[session.index]; const answered = session.answer !== null; const sub = subById(question.sub);
    app.innerHTML = `<header class="pl-quiz-head"><div><span class="kicker">${esc(session.label)} · ${session.index + 1}/${session.questions.length}</span><h1>${esc(sub.title)}</h1></div><b>정답 ${session.correct}</b></header><article class="pl-question"><h2>${esc(question.prompt)}</h2><div class="pl-choices">${question.choices.map((choice, index) => `<button type="button" data-choice="${index}" class="${answered && index === question.answer ? 'is-correct' : answered && index === session.answer ? 'is-wrong' : ''}" ${answered ? 'disabled' : ''}><span>${index + 1}</span>${esc(choice)}</button>`).join('')}</div>${answered ? `<div class="pl-feedback ${session.answer === question.answer ? 'is-correct' : 'is-wrong'}"><strong>${session.answer === question.answer ? '정답' : '오답'}</strong><p>${esc(question.explanation)}</p><button class="btn btn-primary" type="button" data-next>${session.index === session.questions.length - 1 ? '결과 보기' : '다음 문제'}</button></div>` : ''}</article>`;
    app.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', () => choose(button.dataset.choice))); app.querySelector('[data-next]')?.addEventListener('click', next);
  }
  function renderResult() { const total = session.questions.length; app.innerHTML = `<section class="pl-result"><span class="kicker">${esc(session.label)} 완료</span><h1>${session.correct}/${total}</h1><p>${Math.round(session.correct / total * 100)}% 정답</p><div><button class="btn btn-primary" type="button" data-again>다시 풀기</button><button class="btn btn-secondary" type="button" data-home>단원 목록</button></div></section>`; app.querySelector('[data-again]').addEventListener('click', () => startQuiz(session.questions, session.label)); app.querySelector('[data-home]').addEventListener('click', renderHome); }
  // 학습 기록 = 대단원별 그룹 리스트. 행은 제목 + 우측 값(풀이 수 · 정답률)이고 부제를 두지 않는다.
  function renderProgress() { setNav('progress'); app.innerHTML = `<header class="view-head"><div class="view-head-main"><div><h1>학습 기록</h1></div></div></header>${data.UNITS.map((unit) => `<section aria-labelledby="pl-progress-${unit.id}"><h2 class="list-group-head" id="pl-progress-${unit.id}">${esc(unit.id)} · ${esc(unit.title)}</h2><div class="list-group">${unit.subs.map((sub) => { const row = progress[sub.id] || { answered: 0, correct: 0 }; const rate = row.answered ? Math.round(row.correct / row.answered * 100) : 0; return `<button type="button" class="list-row list-row-nav" data-sub="${sub.id}"><span class="list-row-body"><span class="list-row-title">${esc(sub.title)}</span></span><span class="list-row-value num">${row.answered}문항 · ${rate}%</span></button>`; }).join('')}</div></section>`).join('')}`; app.querySelectorAll('[data-sub]').forEach((button) => button.addEventListener('click', () => renderConcept(button.dataset.sub))); }
  document.querySelectorAll('.pl-nav').forEach((button) => button.addEventListener('click', () => button.dataset.view === 'progress' ? renderProgress() : renderHome()));
  document.querySelectorAll('.pl-unit-nav a').forEach((link) => link.addEventListener('click', () => setTimeout(openUnitFromHash, 0)));
  window.addEventListener('hashchange', openUnitFromHash);
  window.PLSTUDY_CONTENT_READY.then(() => { data = window.PLSTUDY_CONTENT; if (data.UNITS.length !== 6 || subunits().length !== 18 || data.QUESTIONS.length !== 90) throw new Error('정치와 법 데이터가 불완전합니다.'); renderHome(); openUnitFromHash(); }).catch((error) => { app.innerHTML = `<section class="pl-error"><h1>학습 데이터를 불러오지 못했습니다.</h1><p>${esc(error.message)}</p></section>`; });
})();
