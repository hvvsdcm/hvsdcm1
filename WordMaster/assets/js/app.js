(() => {
  'use strict';

  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  function start() {

  // 인증된 Worker 데이터와 localStorage 기반 학습 상태를 연결하는 화면 컨트롤러다.
  // 데이터 불변식(50 DAY × 40개)은 루트 검증 스크립트에서 별도로 확인한다.
  const EXPECTED_WORD_COUNT = 2000;
  const MAX_DAY = 50;
  const WORDS = Array.isArray(window.WORDMASTER_WORDS) ? window.WORDMASTER_WORDS : [];
  const WORD_BY_ID = new Map(WORDS.map((item) => [item.id, item]));
  const STORAGE_KEY = 'wordmaster2000.quiz.v1';
  const studyUtils = window.HvsStudyUtils;
  const scheduler = window.HvsWordmasterScheduler;

  if (!studyUtils || !scheduler || !window.HvsWordmasterDailyUi) {
    app.innerHTML = '<div class="card"><h2>화면 로드 오류</h2><p>공통 학습 도구를 불러오지 못했습니다.</p></div>';
    return;
  }

  const {
    SORT_MODES,
    acceptedMeaningAliases,
    createToast,
    escapeHtml,
    matchesMeaningAnswer,
    matchesStudySearch,
    normalizeMeaningAnswer,
    sortStudyItems,
  } = studyUtils;

  // 토스트는 공용 팩토리 하나를 쓴다 — 표시 시간만 화면별로 다르다.
  const showToast = createToast(toast, 1900);

  // 행·헤더 아이콘은 키 → ui-icons.svg 심볼 id 상수 하나에서 나온다 (DESIGN.md §5 v14).
  // 페이로드의 emoji 필드는 읽지 않는다 — 화면에 이모지를 렌더하지 않는다. 키는 항상
  // 리터럴로 넘긴다. 페이로드 emoji 키 15개(app·range·preset·count·order·attempts·accuracy·
  // wrong·study·retest·correct·incorrect·backup·restore·reset)를 빠짐없이 덮는다.
  const ICONS = Object.freeze({
    app: 'icon-book-open',
    range: 'icon-calendar',
    preset: 'icon-bolt',
    count: 'icon-hash',
    order: 'icon-shuffle',
    attempts: 'icon-pen',
    accuracy: 'icon-target',
    wrong: 'icon-bookmark',
    study: 'icon-eye',
    retest: 'icon-refresh',
    correct: 'icon-check-circle',
    incorrect: 'icon-x',
    backup: 'icon-file',
    restore: 'icon-database',
    reset: 'icon-x',
  });

  function uiIcon(id) {
    return `<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#${id}"></use></svg>`;
  }

  // 'lg'는 뷰 헤더(.view-head-main 직계, 20px), 기본은 행 선두(.list-row-lead, 17px).
  function iconLead(key, variant) {
    const id = ICONS[key] || ICONS.app;
    return variant === 'lg'
      ? uiIcon(id)
      : `<span class="list-row-lead">${uiIcon(id)}</span>`;
  }

  const pad2 = (value) => String(value).padStart(2, '0');

  const state = {
    view: 'home',
    session: null,
    home: {
      startDay: 1,
      endDay: 1,
      questionCount: 'all',
      order: 'random',
    },
    wrongOrder: 'recent',
    wrongSearch: '',
    wrongVisible: 50,
  };

  let db = loadDb();
  db.learning = scheduler.normalize(db.learning, WORDS, db.stats);
  const dailyUi = window.HvsWordmasterDailyUi.create({
    app, words: WORDS, scheduler, getDb: () => db, save: saveDb,
    start: startDailyQuiz, resume: resumeSavedSession, settings: renderSettings,
    stats: renderStatsPage, toast: showToast,
  });

  function blankDb() {
    return {
      version: 1,
      learning: scheduler.normalize(null, WORDS),
      stats: {},
      wrongBank: {},
      customAliases: {},
      sessions: 0,
      updatedAt: Date.now(),
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankDb();
      const parsed = JSON.parse(raw);
      return {
        ...blankDb(),
        ...parsed,
        stats: parsed.stats || {},
        wrongBank: parsed.wrongBank || {},
        customAliases: parsed.customAliases || {},
      };
    } catch {
      return blankDb();
    }
  }

  function saveDb() {
    if (state.view === 'quiz' && state.session) db.learning.activeSession = scheduler.serializeSession(state.session);
    if (state.view === 'result') db.learning.activeSession = null;
    db.updatedAt = Date.now();
    const serialized = JSON.stringify(db);
    localStorage.setItem(STORAGE_KEY, serialized);
    window.HvsAccount?.scheduleProgressSync(serialized);
  }

  function clampDay(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_DAY, Math.max(1, n));
  }

  function acceptedAliases(item) {
    return acceptedMeaningAliases(item, db.customAliases[item.id] || []);
  }

  function checkAnswer(item, input) {
    return matchesMeaningAnswer(item, input, db.customAliases[item.id] || []);
  }

  function recordAttempt(item, input, isCorrect, mode) {
    const at = state.session?.lastResult?.at || Date.now();
    const previousCard = db.learning.cards[item.id] || null;
    const current = db.stats[item.id] || {
      attempts: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      lastAnswer: '',
      lastAt: 0,
    };
    current.attempts += 1;
    current.lastAnswer = input;
    current.lastAt = at;
    if (isCorrect) {
      current.correct += 1;
      current.streak = Math.max(0, current.streak) + 1;
      if (mode === 'review' || (['daily', 'scheduled'].includes(mode) && at >= (previousCard?.dueAt || 0))) delete db.wrongBank[item.id];
    } else {
      current.wrong += 1;
      current.streak = 0;
      const wrong = db.wrongBank[item.id] || { count: 0, lastWrongAt: 0, lastAnswer: '' };
      wrong.count += 1;
      wrong.lastWrongAt = at;
      wrong.lastAnswer = input;
      db.wrongBank[item.id] = wrong;
    }
    db.stats[item.id] = current;
    db.learning.cards[item.id] = scheduler.review(previousCard, isCorrect ? 'good' : 'again', at);
    const studyDay = scheduler.recordDaily(db.learning, item.id, isCorrect, !previousCard, at);
    if (state.session?.lastResult) state.session.lastResult.studyDay = studyDay;
    saveDb();
  }

  function addCustomAlias(item, input) {
    const cleaned = String(input || '').trim();
    if (!cleaned) return false;
    const list = db.customAliases[item.id] || [];
    const norm = normalizeMeaningAnswer(cleaned);
    if (!list.some((x) => normalizeMeaningAnswer(x) === norm)) list.push(cleaned);
    db.customAliases[item.id] = list;
    saveDb();
    return true;
  }

  function markCurrentAsAccepted() {
    const session = state.session;
    if (!session || !session.answered || session.lastResult?.correct) return;
    const item = session.questions[session.index];
    const input = session.lastResult.input;
    if (!addCustomAlias(item, input)) return;

    // 방금 오답으로 들어간 기록을 이번 1회에 한해 정답으로 되돌린다.
    const stats = db.stats[item.id];
    if (stats) {
      stats.wrong = Math.max(0, stats.wrong - 1);
      stats.correct += 1;
      stats.streak = Math.max(0, session.lastResult.streakBefore || 0) + 1;
    }
    if (session.mode === 'review') delete db.wrongBank[item.id];
    else {
      const bank = db.wrongBank[item.id];
      if (bank) {
        bank.count = Math.max(0, bank.count - 1);
        if (bank.count === 0) delete db.wrongBank[item.id];
      }
    }
    db.learning.cards[item.id] = scheduler.review(session.lastResult.cardBefore, 'good', session.lastResult.at);
    const day = db.learning.days[session.lastResult.studyDay];
    if (day) day.correct = Math.min(day.attempts, day.correct + 1);
    const retryIndex = session.lastResult.retryIndex;
    if (Number.isInteger(retryIndex) && retryIndex > session.index && session.questions[retryIndex]?.id === item.id) {
      session.questions.splice(retryIndex, 1);
      delete session.retries[item.id];
    }
    session.lastResult.grade = 'good';
    session.correct += 1;
    session.wrong = Math.max(0, session.wrong - 1);
    session.lastResult.correct = true;
    session.lastResult.overridden = true;
    const row = session.results[session.results.length - 1];
    if (row && row.id === item.id) {
      row.correct = true;
      row.overridden = true;
    }
    saveDb();
    window.HvsAccount?.api('/api/answers/accept', {
      method: 'POST',
      body: JSON.stringify({ app: 'wordmaster', questionId: item.id, questionLabel: item.word, baseAnswer: item.meaning, answer: input }),
    }).catch(() => {});
    renderQuiz();
    showToast('이 답을 정답 표현으로 저장했습니다.');
  }

  function summaryStats() {
    const stats = Object.values(db.stats);
    const attempts = stats.reduce((sum, row) => sum + (row.attempts || 0), 0);
    const correct = stats.reduce((sum, row) => sum + (row.correct || 0), 0);
    return {
      attempts,
      correct,
      accuracy: attempts ? Math.round((correct / attempts) * 100) : 0,
      wrongCount: Object.keys(db.wrongBank).filter((id) => WORD_BY_ID.has(id)).length,
    };
  }

  function getRangeWords(start, end) {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return WORDS.filter((item) => item.day >= lo && item.day <= hi);
  }

  function compareWords(left, right) {
    return left.day - right.day || left.number - right.number;
  }

  function personalWrongRate(item) {
    const stats = db.stats[item.id];
    return stats?.attempts ? ((stats.wrong || 0) / stats.attempts) * 100 : null;
  }

  function cumulativeWrongCount(item) {
    return db.stats[item.id]?.wrong || 0;
  }

  function recentAttemptAt(item) {
    return db.stats[item.id]?.lastAt || null;
  }

  function sortWords(items, order) {
    return sortStudyItems(items, order, {
      wrongRate: personalWrongRate,
      wrongCount: cumulativeWrongCount,
      recentAt: recentAttemptAt,
      compareDefault: compareWords,
    });
  }

  function renderSortOptions(selected, sequentialLabel = 'DAY 순서') {
    const options = [
      [SORT_MODES.RANDOM, '랜덤'],
      [SORT_MODES.SEQUENTIAL, sequentialLabel],
      [SORT_MODES.WRONG_HIGH, '오답률 높은 순'],
      [SORT_MODES.WRONG_LOW, '오답률 낮은 순'],
      [SORT_MODES.RECENT, '최근 풀이 순'],
    ];
    return options.map(([value, label]) => (
      `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
    )).join('');
  }

  function filterWrongEntries(entries, query) {
    return entries.filter(({ item }) => matchesStudySearch(query, [item.word, item.meaning]));
  }

  function renderWrongEntryRows(entries, hasWrongItems) {
    if (!entries.length) {
      return `<p class="wm-empty">${hasWrongItems ? '검색 결과가 없습니다.' : '아직 오답이 없습니다.'}</p>`;
    }
    return entries.slice(0, state.wrongVisible).map(({ item, info }) => `
      <div class="list-row wm-mistake">
        <span class="list-row-body">
          <span class="list-row-title wm-term">${escapeHtml(item.word)}</span>
          <span class="list-row-sub">${escapeHtml(item.meaning)}</span>
        </span>
        <span class="list-row-value wm-meta">
          <span>DAY ${pad2(item.day)} · 오답률 ${Math.round(personalWrongRate(item) || 0)}% · 누적 ${info.count || 1}회</span>
          <small>최근 답 · ${escapeHtml(info.lastAnswer || '(빈 답)')}</small>
        </span>
      </div>
    `).join('');
  }

  function updateWrongNoteResults(entries) {
    const filteredEntries = filterWrongEntries(entries, state.wrongSearch);
    const title = document.getElementById('wrongNoteTitle');
    const list = document.getElementById('wrongEntriesList');
    const reviewButton = document.getElementById('statsReviewBtn');
    const count = document.getElementById('wrongVisibleCount');
    const moreButton = document.getElementById('wrongMoreBtn');
    if (title) title.textContent = `오답 암기 노트 · 검색 결과 ${filteredEntries.length.toLocaleString()}개`;
    if (list) list.innerHTML = renderWrongEntryRows(filteredEntries, entries.length > 0);
    if (reviewButton) reviewButton.disabled = filteredEntries.length === 0;
    if (count) count.textContent = `${Math.min(state.wrongVisible, filteredEntries.length).toLocaleString()} / ${filteredEntries.length.toLocaleString()}개`;
    if (moreButton) moreButton.hidden = state.wrongVisible >= filteredEntries.length;
    return filteredEntries;
  }

  function sessionLabel(session) {
    if (session.mode === 'daily') return '오늘의 학습';
    if (session.mode === 'scheduled') return '맞춤 복습';
    if (session.mode === 'review') return '오답 재시험';
    return session.startDay === session.endDay
      ? `DAY ${String(session.startDay).padStart(2, '0')}`
      : `DAY ${String(session.startDay).padStart(2, '0')}–${String(session.endDay).padStart(2, '0')}`;
  }

  function startRangeQuiz() {
    const startInput = document.getElementById('startDay');
    const endInput = document.getElementById('endDay');
    const countSelect = document.getElementById('questionCount');
    const orderSelect = document.getElementById('orderMode');
    let startDay = clampDay(startInput?.value ?? state.home.startDay);
    let endDay = clampDay(endInput?.value ?? state.home.endDay);
    if (startDay > endDay) [startDay, endDay] = [endDay, startDay];

    const countChoice = countSelect?.value || 'all';
    const order = orderSelect?.value || 'random';
    state.home = { startDay, endDay, questionCount: countChoice, order };

    let pool = sortWords(getRangeWords(startDay, endDay), order);
    if (countChoice !== 'all') {
      const limit = Math.max(1, Number.parseInt(countChoice, 10) || pool.length);
      pool = pool.slice(0, Math.min(limit, pool.length));
    }

    startSession(pool, { mode: 'range', startDay, endDay });
  }

  function startReviewQuiz(ids = null, order = SORT_MODES.RANDOM) {
    const sourceIds = ids || Object.keys(db.wrongBank);
    const questions = sortWords(sourceIds.map((id) => WORD_BY_ID.get(id)).filter(Boolean), order);
    if (!questions.length) {
      showToast('현재 오답 노트가 비어 있습니다.');
      renderHome();
      return;
    }
    startSession(questions, { mode: 'review', startDay: null, endDay: null });
  }

  function startDailyQuiz(mode = 'daily') {
    const plan = scheduler.plan(WORDS, db.learning, mode);
    if (!plan.questions.length) {
      showToast(mode === 'scheduled' ? '지금 복습할 단어가 없어요.' : '학습 범위를 넓히거나 다음 복습을 확인해주세요.');
      return mode === 'scheduled' ? renderReviewPage() : renderHome();
    }
    startSession(plan.questions, { mode, startDay: db.learning.settings.startDay, endDay: db.learning.settings.endDay });
  }

  function resumeSavedSession() {
    const restored = scheduler.restoreSession(db.learning.activeSession, WORDS);
    if (!restored) {
      db.learning.activeSession = null;
      saveDb(); renderHome();
      return showToast('이어서 풀기 목록을 불러오지 못했어요. 학습 기록은 유지돼요.');
    }
    state.session = restored; state.view = 'quiz'; renderQuiz();
  }

  function startSession(questions, meta) {
    if (db.learning.activeSession && !state.session && !window.confirm('이어서 풀 수 있는 학습이 있어요. 기존 학습 기록은 남기고 새로 시작할까요?')) return;
    if (!questions.length) {
      showToast('선택한 범위에 문제가 없습니다.');
      return;
    }
    state.session = {
      ...meta,
      questions,
      originalCount: questions.length,
      retries: {},
      index: 0,
      correct: 0,
      wrong: 0,
      answered: false,
      lastResult: null,
      results: [],
      startedAt: Date.now(),
    };
    state.view = 'quiz';
    db.sessions += 1;
    saveDb();
    renderQuiz();
  }

  function submitAnswer() {
    const session = state.session;
    if (!session || session.answered) {
      if (session?.answered) nextQuestion();
      return;
    }
    const item = session.questions[session.index];
    const inputEl = document.getElementById('answerInput');
    const input = String(inputEl?.value || '').trim();
    if (input === '고준서') {
      showToast('준서야 공부해라');
      inputEl.value = '';
      inputEl.focus();
      return;
    }
    const correct = checkAnswer(item, input);

    session.answered = true;
    session.lastResult = {
      input, correct, overridden: false, at: Date.now(), grade: correct ? 'good' : 'again',
      cardBefore: db.learning.cards[item.id] ? { ...db.learning.cards[item.id] } : null,
      streakBefore: db.stats[item.id]?.streak || 0,
    };
    if (correct) session.correct += 1;
    else session.wrong += 1;
    session.results.push({ id: item.id, input, correct, overridden: false });
    if (!correct && ['daily', 'scheduled'].includes(session.mode) && !session.retries[item.id]) {
      session.retries[item.id] = true;
      const retryIndex = Math.min(session.questions.length, session.index + 4);
      session.questions.splice(retryIndex, 0, item);
      session.lastResult.retryIndex = retryIndex;
    }
    recordAttempt(item, input, correct, session.mode);
    renderQuiz();
  }

  function nextQuestion() {
    const session = state.session;
    if (!session || !session.answered) return;
    if (session.index >= session.questions.length - 1) {
      state.view = 'result';
      saveDb();
      renderResult();
      return;
    }
    session.index += 1;
    session.answered = false;
    session.lastResult = null;
    saveDb();
    renderQuiz();
  }

  function setNav(view) {
    const active = ['stats', 'settings', 'review'].includes(view) ? view : state.session?.mode === 'scheduled' ? 'review' : 'home';
    document.querySelectorAll('.sidebar-item[data-nav]').forEach((item) => {
      const on = item.dataset.nav === active;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  function renderHome() {
    state.view = 'home'; state.session = null; setNav('home'); dailyUi.home();
  }

  function renderReviewPage() {
    state.view = 'review'; state.session = null; setNav('review'); dailyUi.review();
  }

  function renderSettings() {
    state.view = 'settings';
    state.session = null;
    setNav('settings');
    const s = summaryStats();
    // 첫 화면 = 제목 한 줄(대표 행동 "시험 시작" 하나) → "시험 설정" 그룹 → "학습 현황" 그룹.
    // hero·설명문·배지를 두지 않는다 — 설정 행 자체가 무엇을 고르는지 말한다 (DESIGN.md §1·§6.1).
    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${iconLead('app', 'lg')}
          <div>
            <h1>시험 설정</h1>
          </div>
        </div>
        <button id="startQuizBtn" class="btn btn-primary" type="button">시험 시작</button>
      </header>

      <div class="wm-layout">
        <section class="wm-col" aria-labelledby="rangeHead">
          <h2 class="list-group-head" id="rangeHead">시험 설정</h2>
          <div class="list-group">
            <div class="list-row">
              ${iconLead('range')}
              <span class="list-row-body"><span class="list-row-title">DAY 범위</span></span>
              <span class="list-row-value wm-range">
                <input id="startDay" class="wm-num field-input-inline" type="number" min="1" max="50" inputmode="numeric" aria-label="시작 DAY" value="${state.home.startDay}">
                <span aria-hidden="true">–</span>
                <input id="endDay" class="wm-num field-input-inline" type="number" min="1" max="50" inputmode="numeric" aria-label="끝 DAY" value="${state.home.endDay}">
              </span>
            </div>
            <div class="list-row is-stacked">
              ${iconLead('preset')}
              <span class="list-row-body"><span class="list-row-title">빠른 선택</span></span>
              <span class="segmented wm-presets" role="group" aria-label="DAY 범위 빠른 선택">
                <button class="segmented-btn preset" type="button" data-start="1" data-end="1">1</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="10">1–10</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="25">1–25</button>
                <button class="segmented-btn preset" type="button" data-start="26" data-end="50">26–50</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="50">전체</button>
              </span>
            </div>
            <div class="list-row">
              ${iconLead('count')}
              <span class="list-row-body"><label class="list-row-title" for="questionCount">문제 수</label></span>
              <span class="list-row-value">
                <select id="questionCount" class="field-input-inline">
                  <option value="25" ${state.home.questionCount === '25' ? 'selected' : ''}>25개</option>
                  <option value="50" ${state.home.questionCount === '50' ? 'selected' : ''}>50개</option>
                  <option value="100" ${state.home.questionCount === '100' ? 'selected' : ''}>100개</option>
                  <option value="all" ${state.home.questionCount === 'all' ? 'selected' : ''}>전체</option>
                </select>
              </span>
            </div>
            <div class="list-row">
              ${iconLead('order')}
              <span class="list-row-body"><label class="list-row-title" for="orderMode">출제 순서</label></span>
              <span class="list-row-value"><select id="orderMode" class="field-input-inline">${renderSortOptions(state.home.order)}</select></span>
            </div>
          </div>
        </section>

        <!-- 현황은 값만 낸다(.list-row-value). 오답 행동 두 개는 같은 그룹의 이동 행이다 —
             현황·오답을 그룹 둘로 나눠 카드 3연속을 만들지 않는다 (DESIGN.md §6). -->
        <aside class="wm-panel">
          <h2 class="list-group-head">학습 현황</h2>
          <div class="list-group">
            <div class="list-row">
              ${iconLead('attempts')}
              <span class="list-row-body"><span class="list-row-title">총 풀이</span></span>
              <span class="list-row-value">${s.attempts.toLocaleString()}</span>
            </div>
            <div class="list-row">
              ${iconLead('accuracy')}
              <span class="list-row-body"><span class="list-row-title">정답률</span></span>
              <span class="list-row-value">${s.accuracy}%</span>
            </div>
            <div class="list-row">
              ${iconLead('wrong')}
              <span class="list-row-body"><span class="list-row-title">오답 노트</span></span>
              <span class="list-row-value">${s.wrongCount.toLocaleString()}</span>
            </div>
            <button id="wrongStudyBtn" class="list-row list-row-nav" type="button" ${s.wrongCount ? '' : 'disabled'}>
              ${iconLead('study')}
              <span class="list-row-body"><span class="list-row-title">오답 보고 외우기</span></span>
            </button>
            <button id="reviewBtn" class="list-row list-row-nav" type="button" ${s.wrongCount ? '' : 'disabled'}>
              ${iconLead('retest')}
              <span class="list-row-body"><span class="list-row-title">오답 재시험</span></span>
            </button>
          </div>
        </aside>
      </div>
    `;

    document.querySelectorAll('.preset').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('startDay').value = button.dataset.start;
        document.getElementById('endDay').value = button.dataset.end;
      });
    });
    document.getElementById('startQuizBtn').addEventListener('click', startRangeQuiz);
    document.getElementById('wrongStudyBtn').addEventListener('click', renderStatsPage);
    document.getElementById('reviewBtn').addEventListener('click', () => startReviewQuiz());
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }

  function renderQuiz() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'quiz';
    setNav('quiz');
    const item = session.questions[session.index];
    const answered = session.answered;
    const result = session.lastResult;
    const current = session.index + 1;
    const total = session.questions.length;
    const progress = Math.round(((session.index + (answered ? 1 : 0)) / total) * 100);

    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${iconLead('app', 'lg')}
          <div>
            <span class="kicker">${escapeHtml(sessionLabel(session))}</span>
            <h1>${['daily', 'scheduled'].includes(session.mode) ? '단어 학습' : '뜻 시험'}</h1>
          </div>
        </div>
        <span class="badge ${session.wrong ? 'badge-red' : 'badge-green'}">정답 ${session.correct} · 오답 ${session.wrong}</span>
      </header>

      <section class="wm-progress" aria-label="진행 상황">
        <div class="wm-progress-meta"><span>${current} / ${total}</span><span>${progress}%</span></div>
        <div class="wm-track"><div class="wm-fill" style="width:${progress}%"></div></div>
      </section>

      <section class="card wm-question">
        <div class="wm-word-line">
          <h2 class="wm-word">${escapeHtml(item.word)}</h2>
          <span class="badge">DAY ${pad2(item.day)} · ${pad2(item.number)}</span>
        </div>

        <div class="field">
          <label class="field-label" for="answerInput">한국어 뜻</label>
          <div class="wm-answer-row">
            <input id="answerInput" class="field-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="뜻을 입력하세요" value="${answered ? escapeHtml(result.input) : ''}" ${answered ? 'disabled' : ''}>
            <button id="submitBtn" class="btn btn-primary" type="button">${answered ? (current === total ? '결과 보기' : '다음') : '정답 확인'}</button>
          </div>
          <p class="wm-hint">Enter로 정답 확인 · 확인 후 Enter로 다음 문제</p>
          ${!answered ? '<button id="dontKnowBtn" class="btn btn-ghost btn-sm" type="button">모르겠어요</button>' : ''}
        </div>

        ${answered ? renderFeedback(item, result) : ''}
      </section>
    `;

    document.getElementById('submitBtn').addEventListener('click', answered ? nextQuestion : submitAnswer);
    document.getElementById('dontKnowBtn')?.addEventListener('click', () => { document.getElementById('answerInput').value = ''; submitAnswer(); });
    const input = document.getElementById('answerInput');
    if (!answered) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          event.stopPropagation();
          submitAnswer();
        }
      });
      requestAnimationFrame(() => input.focus());
    } else {
      document.getElementById('acceptMineBtn')?.addEventListener('click', markCurrentAsAccepted);
      requestAnimationFrame(() => document.getElementById('submitBtn')?.focus());
    }
  }

  // 채점 결과는 색 패널이 아니라 인셋 그룹 리스트 3행이다 — 문장 하나에 상자 하나를
  // 두르지 않는다 (DESIGN.md §6). 상태는 행 선두 아이콘과 판정 라벨 색이 낸다.
  function renderFeedback(item, result) {
    const isCorrect = result.correct;
    const scheduled = db.learning.cards[item.id];
    const earlyPractice = result.cardBefore?.lastReviewAt > 0 && result.at < result.cardBefore.dueAt;
    return `
      <div class="wm-feedback ${isCorrect ? 'is-correct' : 'is-wrong'}" role="status">
        <div class="wm-verdict-hero">
          <span class="wm-verdict-icon">${isCorrect ? iconLead('correct') : iconLead('incorrect')}</span>
          <span class="wm-verdict-copy"><strong class="wm-verdict">${isCorrect ? '정답이에요' : '틀렸어요'}</strong><span>${isCorrect ? '바로 기억했어요.' : '정답을 확인하고 다시 기억해요.'}</span></span>
          ${result.overridden ? '<span class="badge">내 답을 정답으로 저장함</span>' : ''}
        </div>
        <div class="list-group is-inset">
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">교재 정답</span></span>
            <span class="list-row-value wm-gloss">${escapeHtml(item.meaning)}</span>
          </div>
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">내 답</span></span>
            <span class="list-row-value wm-gloss">${escapeHtml(result.input || '(빈 답)')}</span>
          </div>
        </div>
        <div class="wm-recall-info"><p>다음 복습: <strong>${scheduler.dueLabel(scheduled?.dueAt)}</strong> <span class="wm-auto-review">자동 조정</span></p>
          ${isCorrect && !earlyPractice ? '<p class="wm-hint">정오 기록을 바탕으로 다음 복습 간격을 자동으로 정했어요.</p>' : ''}
          ${earlyPractice && isCorrect ? '<p class="wm-hint">방금 본 단어의 재풀이는 복습 간격을 늘리지 않아요.</p>' : ''}
          ${!isCorrect && Number.isInteger(result.retryIndex) ? '<p class="wm-hint">이번 학습 안에서 한 번 더 확인해요.</p>' : ''}
        </div>
        ${!isCorrect && result.input
          ? '<button id="acceptMineBtn" class="btn btn-secondary btn-sm" type="button">내 답도 정답으로 인정</button>'
          : ''}
      </div>
    `;
  }

  function renderResult() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'result';
    setNav('result');
    const total = session.questions.length;
    const accuracy = total ? Math.round((session.correct / total) * 100) : 0;
    const wrongRows = session.results.filter((row) => !row.correct);
    const daily = scheduler.summary(WORDS, db.learning);

    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${iconLead('app', 'lg')}
          <div>
            <span class="kicker">${escapeHtml(sessionLabel(session))} 완료</span>
            <h1>${['daily', 'scheduled'].includes(session.mode) ? '학습 완료' : '시험 결과'}</h1>
          </div>
        </div>
        <div class="wm-score">${accuracy}%</div>
      </header>
      <section class="wm-session-goal"><h2>${daily.today.count >= db.learning.settings.goal ? '오늘 목표를 달성했어요!' : '오늘의 기억이 쌓였어요.'}</h2><p>하루 목표 ${daily.today.count} / ${db.learning.settings.goal}개 · ${daily.streak}일 연속 학습</p><p class="wm-hint">학습한 단어는 복습 일정에 맞춰 다시 만나요.</p></section>

      <div class="list-group">
        <div class="list-row">
          ${iconLead('correct')}
          <span class="list-row-body"><span class="list-row-title">정답</span></span>
          <span class="list-row-value">${session.correct}</span>
        </div>
        <div class="list-row">
          ${iconLead('incorrect')}
          <span class="list-row-body"><span class="list-row-title">오답</span></span>
          <span class="list-row-value">${session.wrong}</span>
        </div>
        <div class="list-row">
          ${iconLead('count')}
          <span class="list-row-body"><span class="list-row-title">문항</span></span>
          <span class="list-row-value">${total}</span>
        </div>
      </div>

      <div class="wm-actions-row">
        <button id="retryWrongBtn" class="btn btn-primary" type="button" ${wrongRows.length ? '' : 'disabled'}>이번 오답만 재시험</button>
        <button id="resultHomeBtn" class="btn btn-secondary" type="button">오늘의 학습으로</button>
      </div>

      ${wrongRows.length ? `
        <section aria-labelledby="sessionMistakes">
          <h2 class="list-group-head" id="sessionMistakes">이번 시험 오답 ${wrongRows.length}개</h2>
          <div class="list-group">
            ${wrongRows.map((row) => {
              const item = WORD_BY_ID.get(row.id);
              return `
                <div class="list-row wm-mistake">
                  <span class="list-row-body">
                    <span class="list-row-title wm-term">${escapeHtml(item.word)}</span>
                    <span class="list-row-sub">${escapeHtml(item.meaning)}</span>
                  </span>
                  <span class="list-row-value wm-meta">
                    <span>DAY ${pad2(item.day)} · ${pad2(item.number)}</span>
                    <small>내 답 · ${escapeHtml(row.input || '(빈 답)')}</small>
                  </span>
                </div>`;
            }).join('')}
          </div>
        </section>
      ` : ''}
    `;

    document.getElementById('resultHomeBtn').addEventListener('click', renderHome);
    document.getElementById('retryWrongBtn').addEventListener('click', () => startReviewQuiz([...new Set(wrongRows.map((x) => x.id))]));
  }

  function renderStatsPage() {
    state.view = 'stats';
    state.session = null;
    setNav('stats');
    const s = summaryStats();
    const wrongItems = Object.keys(db.wrongBank)
      .map((id) => WORD_BY_ID.get(id))
      .filter(Boolean);
    const wrongEntries = sortWords(wrongItems, state.wrongOrder)
      .map((item) => ({ item, info: db.wrongBank[item.id] }));
    const filteredWrongEntries = filterWrongEntries(wrongEntries, state.wrongSearch);

    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${iconLead('app', 'lg')}
          <div>
            <h1>학습 기록</h1>
          </div>
        </div>
        <button id="statsBackBtn" class="btn btn-secondary btn-sm" type="button">오늘의 학습</button>
      </header>

      <div class="wm-layout">
        <section class="wm-col" aria-labelledby="wrongNoteTitle">
          <div class="wm-wrong-head">
            <h2 class="list-group-head" id="wrongNoteTitle" aria-live="polite">오답 암기 노트 · 검색 결과 ${filteredWrongEntries.length.toLocaleString()}개</h2>
            <div class="wm-wrong-controls">
              <label class="sr-only" for="wrongSearchInput">영어 단어 또는 한국어 뜻 검색</label>
              <input id="wrongSearchInput" class="field-input field-input-sm wm-search-input" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="영단어 또는 뜻 검색" aria-controls="wrongEntriesList" value="${escapeHtml(state.wrongSearch)}">
              <div class="wm-sort">
                <label class="wm-sort-label" for="wrongSortMode">정렬</label>
                <select id="wrongSortMode" class="field-input-inline">${renderSortOptions(state.wrongOrder)}</select>
                <button id="statsReviewBtn" class="btn btn-primary btn-sm" type="button" ${filteredWrongEntries.length ? '' : 'disabled'}>재시험</button>
              </div>
            </div>
          </div>
          <div id="wrongEntriesList" class="list-group">
            ${renderWrongEntryRows(filteredWrongEntries, wrongEntries.length > 0)}
          </div>
          <div class="toolbar" aria-live="polite">
            <span id="wrongVisibleCount" class="text-secondary">${Math.min(state.wrongVisible, filteredWrongEntries.length).toLocaleString()} / ${filteredWrongEntries.length.toLocaleString()}개</span>
            <span class="toolbar-spacer"></span>
            <button id="wrongMoreBtn" class="btn btn-secondary btn-sm" type="button" ${state.wrongVisible >= filteredWrongEntries.length ? 'hidden' : ''}>50개 더 보기</button>
          </div>
        </section>

        <aside class="wm-panel">
          <h2 class="list-group-head">누적 지표</h2>
          <div class="list-group">
            <div class="list-row">
              ${iconLead('attempts')}
              <span class="list-row-body"><span class="list-row-title">총 풀이</span></span>
              <span class="list-row-value">${s.attempts.toLocaleString()}</span>
            </div>
            <div class="list-row">
              ${iconLead('accuracy')}
              <span class="list-row-body"><span class="list-row-title">정답률</span></span>
              <span class="list-row-value">${s.accuracy}%</span>
            </div>
            <div class="list-row">
              ${iconLead('wrong')}
              <span class="list-row-body"><span class="list-row-title">오답 노트</span></span>
              <span class="list-row-value">${s.wrongCount.toLocaleString()}</span>
            </div>
          </div>

          <h2 class="list-group-head">기록 데이터</h2>
          <div class="list-group">
            <button id="exportBtn" class="list-row list-row-nav" type="button">
              ${iconLead('backup')}
              <span class="list-row-body"><span class="list-row-title">기록 백업</span></span>
            </button>
            <label class="list-row list-row-nav" for="importFile">
              ${iconLead('restore')}
              <span class="list-row-body"><span class="list-row-title">기록 복원</span></span>
            </label>
            <button id="resetBtn" class="list-row wm-row-danger" type="button">
              ${iconLead('reset')}
              <span class="list-row-body"><span class="list-row-title">기록 초기화</span></span>
            </button>
          </div>
          <!-- 파일 입력은 그룹 밖에 둔다 — 행 사이에 끼우면 .list-row + .list-row 구분선이 끊긴다. -->
          <input id="importFile" class="sr-only" type="file" accept="application/json,.json">
        </aside>
      </div>
    `;

    document.getElementById('statsBackBtn').addEventListener('click', renderHome);
    document.getElementById('wrongSearchInput').addEventListener('input', (event) => {
      state.wrongSearch = event.target.value;
      state.wrongVisible = 50;
      updateWrongNoteResults(wrongEntries);
    });
    document.getElementById('wrongSortMode').addEventListener('change', (event) => {
      state.wrongOrder = event.target.value;
      state.wrongVisible = 50;
      renderStatsPage();
    });
    document.getElementById('wrongMoreBtn').addEventListener('click', () => {
      state.wrongVisible += 50;
      updateWrongNoteResults(wrongEntries);
    });
    document.getElementById('statsReviewBtn').addEventListener('click', () => {
      const currentResults = filterWrongEntries(wrongEntries, state.wrongSearch);
      startReviewQuiz(currentResults.map(({ item }) => item.id), state.wrongOrder);
    });
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importFile').addEventListener('change', importData);
    document.getElementById('resetBtn').addEventListener('click', resetData);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wordmaster-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast('학습 기록을 백업했습니다.');
  }

  async function importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object') throw new Error('bad format');
      db = {
        ...blankDb(),
        ...parsed,
        stats: parsed.stats || {},
        wrongBank: parsed.wrongBank || {},
        customAliases: parsed.customAliases || {},
      };
      db.learning = scheduler.normalize(db.learning, WORDS, db.stats);
      saveDb();
      renderStatsPage();
      showToast('학습 기록을 복원했습니다.');
    } catch {
      showToast('올바른 백업 파일이 아닙니다.');
    } finally {
      event.target.value = '';
    }
  }

  function resetData() {
    const ok = window.confirm('오답, 정답률, 사용자 정답 표현을 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.');
    if (!ok) return;
    db = blankDb();
    saveDb();
    renderStatsPage();
    showToast('학습 기록을 초기화했습니다.');
  }

  function goHomeWithConfirm() {
    if (state.view === 'quiz' && state.session && state.session.index > 0) {
      if (!window.confirm('진행 중인 시험을 종료하고 홈으로 갈까요?')) return;
    }
    renderHome();
  }

  document.getElementById('homeLogo').addEventListener('click', goHomeWithConfirm);
  document.getElementById('openReviewBtn').addEventListener('click', renderReviewPage);
  document.getElementById('openSettingsBtn').addEventListener('click', renderSettings);
  window.addEventListener('wordmaster:review', renderReviewPage);
  function refreshDashboard() {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    if (state.view === 'home') dailyUi.home();
    else if (state.view === 'review') dailyUi.review();
  }
  document.addEventListener('visibilitychange', refreshDashboard);
  setInterval(refreshDashboard, 30_000);
  document.getElementById('openStatsBtn').addEventListener('click', () => {
    if (state.view === 'quiz' && !window.confirm('진행 중인 시험을 종료하고 기록을 볼까요?')) return;
    renderStatsPage();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.view === 'quiz' && state.session?.answered) {
      const active = document.activeElement;
      if (active?.id === 'acceptMineBtn' || active?.tagName === 'BUTTON') return;
      event.preventDefault();
      nextQuestion();
    }
  });

  if (WORDS.length !== EXPECTED_WORD_COUNT) {
    app.innerHTML = `<div class="card"><h2>데이터 로드 오류</h2><p>단어 데이터가 ${WORDS.length}개만 로드되었습니다.</p></div>`;
  } else {
    renderHome();
  }
  }

  const dependencies = [window.WORDMASTER_CONTENT_READY, window.HvsAccount?.ready].filter(Boolean);
  const ready = dependencies.length ? Promise.all(dependencies) : null;
  if (ready) {
    ready.then(start).catch((error) => {
      if (error?.message !== 'unauthorized') {
        app.innerHTML = '<div class="card"><h2>데이터 로드 오류</h2><p>단어 데이터를 불러오지 못했습니다.</p></div>';
      }
    });
  } else {
    start();
  }
})();
