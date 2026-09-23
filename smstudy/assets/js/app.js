(() => {
  'use strict';

  const STORAGE_KEY = 'samun2027.study.v1';
  const EXPECTED_QUESTION_COUNT = 98;
  const EXPECTED_SUBUNIT_COUNT = 17;
  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  function start() {
  const studyUtils = window.HvsStudyUtils;
  // 페이로드의 EMOJI 매핑은 읽지 않는다 — 화면에 이모지를 렌더하지 않는다(DESIGN.md §5 v14).
  const {
    CHOICE_MARKS,
    QUESTIONS,
    UNITS
  } = window.SMSTUDY_DATA || {};
  const {
    LEARNING_DESIGN,
    NOTEBOOKS
  } = window.SMSTUDY_NOTEBOOK || {};
  const {
    EBS_PAST_EXAMS,
    GUIDES: EXPLANATION_GUIDES
  } = window.SMSTUDY_EXPLANATIONS || {};
  // 아이콘은 사이트 공통 스프라이트(assets/ui-icons.svg)만 쓴다 — 두 번째 외부 세트는 소비하지 않는다(DESIGN.md §5).
  const { renderDiagram } = window.SMSTUDY_DIAGRAM || {};

  // data.js가 먼저 로드되어야 한다. 불완전한 배포는 사용자에게 오류 화면으로 알린다.
  if (!studyUtils || !Array.isArray(CHOICE_MARKS) || !Array.isArray(QUESTIONS) || !Array.isArray(UNITS) || !LEARNING_DESIGN || !NOTEBOOKS || !EBS_PAST_EXAMS || !EXPLANATION_GUIDES || !renderDiagram) {
    app.innerHTML = '<div class="card"><h2>데이터 로드 오류</h2><p>사회·문화 학습 데이터를 불러오지 못했습니다.</p></div>';
    return;
  }

  const { SORT_MODES, createToast, escapeHtml: esc, sortStudyItems } = studyUtils;

  const SUBUNITS = UNITS.flatMap(unit => unit.subs.map(sub => ({
    ...sub,
    unitId: unit.id,
    unitTitle: unit.title
  })));
  const UNIT_BY_ID = new Map(UNITS.map(unit => [unit.id, unit]));
  const SUB_BY_ID = new Map(SUBUNITS.map(x => [x.id, x]));
  const Q_BY_ID = new Map(QUESTIONS.map(x => [x.id, x]));
  const QUESTION_ORDER = new Map(QUESTIONS.map((question, index) => [question.id, index]));
  const MISTAKE_REASONS = {
    concept: '개념을 혼동함',
    choice: '선지 비교를 놓침',
    data: '자료·도표 해석 실수',
    calculation: '계산·비율 실수',
    time: '시간 부족·성급한 판단'
  };
  const blankDb = () => ({
    version: 1,
    attempts: 0,
    correct: 0,
    sessions: 0,
    completed: {},
    qStats: {},
    wrongBank: {},
    customAliases: {}
  });
  function loadDb() {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return v && typeof v === 'object' ? {
        ...blankDb(),
        ...v,
        completed: v.completed || {},
        qStats: v.qStats || {},
        wrongBank: v.wrongBank || {},
        customAliases: v.customAliases || {}
      } : blankDb();
    } catch {
      return blankDb();
    }
  }
  let db = loadDb();
  db.wrongBank = Object.fromEntries(Object.entries(db.wrongBank).filter(([id]) => Q_BY_ID.has(id)));
  db.customAliases = Object.fromEntries(Object.entries(db.customAliases).filter(([id]) => Q_BY_ID.has(id)));
  function saveDb() {
    const serialized = JSON.stringify(db);
    localStorage.setItem(STORAGE_KEY, serialized);
    window.HvsAccount?.scheduleProgressSync(serialized);
  }
  const state = {
    view: 'home',
    selected: new Set(),
    count: '20',
    order: 'random',
    wrongOrder: 'recent',
    session: null,
    concept: null
  };
  // 토스트는 공용 팩토리 하나를 쓴다 — 표시 시간만 화면별로 다르다.
  const showToast = createToast(toast);
  function compareQuestions(left, right) {
    return QUESTION_ORDER.get(left.id) - QUESTION_ORDER.get(right.id);
  }

  function recentAttemptAt(question) {
    return db.qStats[question.id]?.lastAt || null;
  }

  function cumulativeWrongCount(question) {
    return db.qStats[question.id]?.wrong || 0;
  }

  function sortQuestions(questions, order) {
    return sortStudyItems(questions, order, {
      wrongRate: (question) => question.wrongRate,
      wrongCount: cumulativeWrongCount,
      recentAt: recentAttemptAt,
      compareDefault: compareQuestions,
    });
  }

  function renderSortOptions(selected, sequentialLabel = '교재 순서') {
    const options = [
      [SORT_MODES.RANDOM, '랜덤'],
      [SORT_MODES.SEQUENTIAL, sequentialLabel],
      [SORT_MODES.WRONG_HIGH, '정답률 낮은 순'],
      [SORT_MODES.WRONG_LOW, '정답률 높은 순'],
      [SORT_MODES.RECENT, '최근 풀이 순'],
    ];
    return options.map(([value, label]) => (
      `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
    )).join('');
  }
  function stats() {
    const accuracy = db.attempts ? Math.round(db.correct / db.attempts * 100) : 0;
    return {
      accuracy,
      wrong: Object.keys(db.wrongBank).length,
      done: Object.keys(db.completed).length
    };
  }
  function subStats(id) {
    const ids = QUESTIONS.filter(q => q.sub === id).map(q => q.id);
    let a = 0,
      c = 0;
    ids.forEach(qid => {
      const x = db.qStats[qid];
      if (x) {
        a += x.attempts || 0;
        c += x.correct || 0;
      }
    });
    return {
      attempts: a,
      accuracy: a ? Math.round(c / a * 100) : 0
    };
  }
  function aggregateQuestions(questions) {
    let attempts = 0,
      correct = 0,
      wrong = 0;
    for (const question of questions) {
      const row = db.qStats[question.id];
      if (!row) continue;
      attempts += row.attempts || 0;
      correct += row.correct || 0;
      wrong += row.wrong || 0;
    }
    return {
      attempts,
      correct,
      wrong,
      accuracy: attempts ? Math.round(correct / attempts * 100) : null
    };
  }
  function weaknessAnalysis() {
    const subRows = SUBUNITS.map(sub => ({
      id: sub.id,
      title: sub.title,
      unitId: sub.unitId,
      ...aggregateQuestions(QUESTIONS.filter(q => q.sub === sub.id))
    }));
    const unitRows = UNITS.map(unit => ({
      id: unit.id,
      title: unit.title,
      ...aggregateQuestions(QUESTIONS.filter(q => q.sub.startsWith(`${unit.id}-`)))
    }));
    const attemptedSubs = subRows.filter(row => row.attempts).sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
    const attemptedUnits = unitRows.filter(row => row.attempts).sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
    const reasonCounts = Object.values(db.wrongBank).reduce((counts, row) => {
      const reason = row.reason || 'unclassified';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    const dominantReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      subRows,
      unitRows,
      weakestSub: attemptedSubs[0] || null,
      weakestUnit: attemptedUnits[0] || null,
      dominantReason: dominantReason ? {
        key: dominantReason[0],
        count: dominantReason[1],
        label: dominantReason[0] === 'unclassified' ? '원인 미분류' : MISTAKE_REASONS[dominantReason[0]]
      } : null
    };
  }
  function masteryLabel(row) {
    if (!row.attempts) return '미응시';
    if (row.attempts < 3) return '표본 부족';
    if (row.accuracy < 60) return '집중 보완';
    if (row.accuracy < 80) return '추가 복습';
    return '안정';
  }
  function shownAnswer(q, input) {
    const i = Number(input);
    return Number.isInteger(i) && CHOICE_MARKS[i] ? CHOICE_MARKS[i] : '(선택 없음)';
  }
  function check(q, input) {
    const ok = Number(input) === q.correct;
    return {
      correct: ok,
      partial: false,
      hits: ok ? 1 : 0,
      total: 1
    };
  }
  function record(q, input, judged) {
    db.attempts++;
    if (judged.correct) db.correct++;
    const s = db.qStats[q.id] || {
      attempts: 0,
      correct: 0,
      wrong: 0
    };
    s.attempts++;
    s.lastAt = Date.now();
    if (judged.correct) {
      s.correct++;
      delete db.wrongBank[q.id];
    } else {
      s.wrong++;
      const previous = db.wrongBank[q.id] || {};
      db.wrongBank[q.id] = {
        count: (previous.count || 0) + 1,
        lastAnswer: shownAnswer(q, input),
        lastInput: Number(input),
        lastWrongAt: Date.now(),
        sub: q.sub,
        reason: previous.reason || ''
      };
    }
    db.qStats[q.id] = s;
    saveDb();
  }
  function setNav(view) {
    const active = view === 'stats' ? 'stats' : 'home';
    document.querySelectorAll('.sidebar-item[data-nav]').forEach((item) => {
      const on = item.dataset.nav === active;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  function renderOverview(summary) {
    return `
      <div class="sm-metrics">
        <div class="stat"><span class="stat-value">${summary.done}/${SUBUNITS.length}</span><span class="stat-label">개념 완료</span></div>
        <div class="stat"><span class="stat-value">${summary.accuracy}%</span><span class="stat-label">누적 정답률</span></div>
        <div class="stat"><span class="stat-value">${summary.wrong}</span><span class="stat-label">오답 노트</span></div>
      </div>`;
  }

  // 앱 아이콘은 사이트 공통 매핑과 같은 icon-layers 하나다(DESIGN.md §5.1). 뷰 헤더와
  // 개념 노트 머리에서 20px(.view-head-main / .sm-concept-head 직계)로 한 번씩만 놓는다.
  function appIcon() {
    return '<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-layers"></use></svg>';
  }

  function renderStartPanel(summary) {
    return `
      <div class="sm-panel">
        <section class="card sm-stack" aria-labelledby="startTitle">
          <h2 class="title-3" id="startTitle">학습 시작</h2>
          ${renderOverview(summary)}

          <div class="sm-options">
            <div class="field">
              <label class="field-label" for="qCount">문제 수</label>
              <select id="qCount" class="field-input">
                <option value="10" ${state.count === '10' ? 'selected' : ''}>10문제</option>
                <option value="20" ${state.count === '20' ? 'selected' : ''}>20문제</option>
                <option value="40" ${state.count === '40' ? 'selected' : ''}>40문제</option>
                <option value="all" ${state.count === 'all' ? 'selected' : ''}>선택 범위 전체</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="qOrder">출제 순서</label>
              <select id="qOrder" class="field-input">${renderSortOptions(state.order)}</select>
            </div>
          </div>
          <p class="sm-note">정답률은 통사랑 문항별 집계, 최근 순은 내 풀이 기록 기준입니다.</p>

          <button id="startSelected" class="btn btn-primary sm-full" type="button" ${state.selected.size ? '' : 'disabled'}>
            선택 범위 퀴즈 ${state.selected.size}개 중단원
          </button>
          <div class="sm-actions">
            <button id="selectAll" class="btn btn-secondary btn-sm" type="button">전체 선택</button>
            <button id="clearAll" class="btn btn-secondary btn-sm" type="button">선택 해제</button>
          </div>
        </section>

        <!-- 항목마다 카드와 버튼을 반복하던 조판을 그룹 리스트 한 장으로 합쳤다
             (DESIGN.md §6). 행 자체가 동작이므로 행 안에 버튼을 또 두지 않는다. -->
        <details class="sm-quick-review">
          <summary><span id="quickTitle">빠른 복습</span><span>취약 문항 · 오답 · 누적</span></summary>
          <div class="list-group">
            <button id="weakQuiz" class="list-row list-row-nav" type="button">
              <span class="list-row-body">
                <span class="list-row-title">낮은 정답률 기출</span>
                <span class="list-row-sub">출제 정답률 65% 이하</span>
              </span>
            </button>
            <button id="wrongStudy" class="list-row list-row-nav" type="button" ${summary.wrong ? '' : 'disabled'}>
              <span class="list-row-body">
                <span class="list-row-title">오답 보고 외우기</span>
                <span class="list-row-sub">원문 · 원인 · 재시험</span>
              </span>
              <span class="list-row-value num">${summary.wrong}</span>
            </button>
            <button id="wrongQuiz" class="list-row list-row-nav" type="button" ${summary.wrong ? '' : 'disabled'}>
              <span class="list-row-body">
                <span class="list-row-title">오답 재시험</span>
                <span class="list-row-sub">틀린 문항만 다시 출제</span>
              </span>
              <span class="list-row-value num">${summary.wrong}</span>
            </button>
            <button id="cumulative" class="list-row list-row-nav" type="button" ${summary.done ? '' : 'disabled'}>
              <span class="list-row-body">
                <span class="list-row-title">누적 복습</span>
                <span class="list-row-sub">개념 완료 범위 20문제</span>
              </span>
              <span class="list-row-value num">${summary.done}</span>
            </button>
          </div>
        </details>
      </div>`;
  }

  function renderHome() {
    state.view = 'home';
    state.session = null;
    setNav('home');
    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${appIcon()}
          <div>
            <h1>사회·문화</h1>
            <p>개념을 이해하고, 기출로 확인해요.</p>
          </div>
        </div>
        <span class="badge badge-accent">출제 범위 ${state.selected.size}/${SUBUNITS.length}</span>
      </header>

      <div class="sm-layout">
        <aside class="sm-home-tools">${renderStartPanel(stats())}</aside>
        <div class="sm-units">
          ${renderUnitJump()}
          ${UNITS.map(renderUnit).join('')}
        </div>
      </div>`;
    bindHome();
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }

  // 행의 보조 정보는 값 슬롯(.list-row-value)에 짧게 낸다 — 문항 수와 내 정답률뿐이다.
  // 단원 id·소요 시간은 지웠다: id는 그룹 헤더가, 시간은 개념 노트가 말한다 (DESIGN.md §6.1).
  function subMeta(sub) {
    const progress = subStats(sub.id);
    const count = QUESTIONS.filter((question) => question.sub === sub.id).length;
    const parts = [`${count}문항`];
    if (progress.attempts) parts.push(`정답 ${progress.accuracy}%`);
    return parts.join(' · ');
  }

  // 대단원 바로 가기 — 단원 목록 위 한 줄. 앵커 점프라 JS 상태가 없다.
  function renderUnitJump() {
    return `
      <nav class="segmented sm-unit-jump" aria-label="대단원 바로 가기">
        ${UNITS.map((unit) => `<a class="segmented-btn" href="#unit-${unit.id}">${esc(unit.id)}<span class="sr-only"> ${esc(unit.title)}</span></a>`).join('')}
      </nav>`;
  }

  // 중단원 = 행. 행 자체가 개념 학습 진입점이고(늘린 히트 영역), 오른쪽 액세서리는
  // 출제 범위 체크박스 하나뿐이다. 행마다 버튼을 반복하지 않는다 (DESIGN.md §6·§7.1).
  // 부제(.list-row-sub)를 두지 않는다 — 설명문이 아니라 값이므로 .list-row-value 하나에 모은다.
  // 행 선두는 단원 번호 텍스트(로마 숫자-번호, --text-3 tabular)다 — 이모지 타일을 폐기했다(§5 v14).
  function renderSubunit(sub) {
    const done = Boolean(db.completed[sub.id]);
    return `
      <div class="list-row">
        <span class="list-row-lead"><span class="sm-sub-id">${esc(sub.id)}</span></span>
        <span class="list-row-body">
          <button class="list-row-stretch" type="button" data-id="${sub.id}">
            <span class="list-row-title">${esc(sub.title)}</span>
          </button>
        </span>
        <span class="list-row-value">${done ? '<span class="badge badge-green">완료</span> ' : ''}${esc(subMeta(sub))}</span>
        <label class="list-row-accessory">
          <input class="sub-check" type="checkbox" data-id="${sub.id}"
            aria-label="${esc(sub.title)} 출제 범위 포함" ${state.selected.has(sub.id) ? 'checked' : ''}>
        </label>
      </div>`;
  }

  // 대단원 = 그룹. 범위 선택은 그룹 헤더의 토글 하나로 모은다.
  // 그룹 아래 각주(.list-group-foot)는 지웠다 — 선택 수는 체크박스가, 완료는 행 배지가 낸다.
  function renderUnit(unit) {
    const total = unit.subs.length;
    const selectedCount = unit.subs.filter((sub) => state.selected.has(sub.id)).length;
    const allSelected = selectedCount === total;
    return `
      <section class="sm-unit" aria-labelledby="unit-${unit.id}">
        <div class="list-group-head-row">
          <h2 class="list-group-head" id="unit-${unit.id}">${esc(unit.id)} · ${esc(unit.title)}</h2>
          <button class="btn btn-ghost btn-sm unit-toggle" type="button" data-unit="${unit.id}">${allSelected ? '범위 해제' : '전체 선택'}</button>
        </div>
        <div class="list-group">${unit.subs.map(renderSubunit).join('')}</div>
      </section>`;
  }
  function bindHome() {
    const setUnitSelection = (unitId, selected) => {
      const unit = UNIT_BY_ID.get(unitId);
      if (!unit) return;
      for (const sub of unit.subs) selected ? state.selected.add(sub.id) : state.selected.delete(sub.id);
      renderHome();
    };
    document.querySelectorAll('.unit-toggle').forEach(el => el.addEventListener('click', () => {
      const unit = UNIT_BY_ID.get(el.dataset.unit);
      const allSelected = unit?.subs.every(sub => state.selected.has(sub.id));
      setUnitSelection(el.dataset.unit, !allSelected);
    }));
    document.querySelectorAll('.sub-check').forEach(el => el.addEventListener('change', () => {
      const id = el.dataset.id;
      el.checked ? state.selected.add(id) : state.selected.delete(id);
      renderHome();
      requestAnimationFrame(() => document.querySelector(`.sub-check[data-id="${id}"]`)?.focus({ preventScroll: true }));
    }));
    document.querySelectorAll('.list-row-stretch').forEach(el => el.addEventListener('click', () => renderConcept(el.dataset.id)));
    document.getElementById('qCount').addEventListener('change', e => state.count = e.target.value);
    document.getElementById('qOrder').addEventListener('change', e => state.order = e.target.value);
    document.getElementById('startSelected').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => state.selected.has(q.sub)), '선택 범위'));
    document.getElementById('selectAll').addEventListener('click', () => {
      state.selected = new Set(SUBUNITS.map(x => x.id));
      renderHome();
    });
    document.getElementById('clearAll').addEventListener('click', () => {
      state.selected.clear();
      renderHome();
    });
    document.getElementById('weakQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.weak), '취약 개념'));
    document.getElementById('wrongStudy').addEventListener('click', renderStats);
    document.getElementById('wrongQuiz').addEventListener('click', () => startQuiz(Object.keys(db.wrongBank).map(id => Q_BY_ID.get(id)).filter(Boolean), '오답 재시험', 'all'));
    document.getElementById('cumulative').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => db.completed[q.sub]), '누적 복습', '20'));
  }
  // 섹션 머리 — 눈썹 라벨 + 큰 제목의 두 줄 조판을 한 줄짜리 그룹 헤더로 줄였다.
  // 섹션마다 두 줄씩 붙던 chrome이 이 화면 세로 길이의 큰 몫이었다 (DESIGN.md §6).
  function sectionHead(id, label, extra = '') {
    return `<div class="sm-sec-head"><h2 class="sm-sec-label" id="${id}">${esc(label)}</h2>${extra}</div>`;
  }

  // 접히는 부속 섹션. 항상 보여야 하는 것(핵심·구조·변별표·판단 순서·회상)과
  // 필요할 때만 펼치는 것(빈출 목록·세부 개념·설계 근거)을 나눈다.
  // data-print-open은 인쇄 직전에 강제로 펼치기 위한 표지다.
  function foldSection(id, label, hint, body) {
    return `
      <details class="disclosure" data-print-open>
        <summary class="disclosure-head">
          <h2 class="disclosure-title" id="${id}">${esc(label)}</h2>
          <span class="disclosure-hint">${esc(hint)}</span>
        </summary>
        <div class="disclosure-body">${body}</div>
      </details>`;
  }

  // 중단원 13개를 칩으로 늘어놓던 줄을 대단원별 optgroup을 가진 select 하나로 바꿨다.
  // 배타 선택지가 5개를 넘으면 세그먼티드가 아니라 select다 (DESIGN.md §7.2).
  function renderConceptNavigation(id, index, questionCount) {
    const options = UNITS.map((unit) => {
      const items = unit.subs.map((subunit) => (
        `<option value="${subunit.id}" ${subunit.id === id ? 'selected' : ''}>${esc(`${subunit.id} · ${subunit.title}`)}</option>`
      )).join('');
      return `<optgroup label="${esc(`${unit.id} · ${unit.title}`)}">${items}</optgroup>`;
    }).join('');
    return `
      <nav class="toolbar toolbar-sticky sm-concept-nav" aria-label="중단원 이동">
        <button id="prevConcept" class="btn btn-secondary btn-sm" type="button" aria-label="이전 중단원" ${index === 0 ? 'disabled' : ''}>←</button>
        <label class="sm-jump-label" for="jumpConcept">중단원</label>
        <select id="jumpConcept" class="field-input sm-jump">${options}</select>
        <button id="nextConcept" class="btn btn-secondary btn-sm" type="button" aria-label="다음 중단원" ${index === SUBUNITS.length - 1 ? 'disabled' : ''}>→</button>
        <div class="toolbar-spacer"></div>
        <button id="conceptHome" class="btn btn-ghost btn-sm" type="button">단원 목록</button>
        <button id="subQuiz" class="btn btn-primary btn-sm" type="button">퀴즈 ${questionCount}문제</button>
      </nav>`;
  }

  function renderConceptSection(section) {
    return `
      <article class="sm-concept-card">
        <h3 class="title-3">${esc(section.title)}</h3>
        <ul class="sm-bullets">${section.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>
        <p class="sm-trap"><strong>함정 체크</strong>${esc(section.trap)}</p>
      </article>`;
  }

  // 핵심 — 헤드라인 + 요약 명제 + 핵심 개념 세 줄. 카드 스택이 아니라 그룹 리스트다.
  function renderCore(sub, note) {
    const summary = note.summary.map((line) => `<li>${esc(line)}</li>`).join('');
    const keyPoints = note.keyPoints.map((item) => `
      <div class="list-row">
        <span class="list-row-body">
          <span class="list-row-title">${esc(item.label)}</span>
          <span class="list-row-sub">${esc(item.text)}</span>
        </span>
      </div>`).join('');
    return `
      <section id="concept-core" class="sm-section sm-core" aria-labelledby="core-title">
        ${sectionHead('core-title', '핵심 개념')}
        <p class="sm-headline">${esc(note.headline)}</p>
        <div class="list-group">${keyPoints}</div>
        <p class="list-group-foot">핵심어 ${esc(sub.keywords)}</p>
        <details class="sm-learning-points"><summary>학습 포인트</summary><ul class="sm-summary">${summary}</ul><p class="list-group-foot">문항 수와 정답률은 이 사이트에 수록된 표본 기준입니다.</p></details>
      </section>`;
  }

  function renderDiagramSection(note) {
    const diagrams = (note.diagrams || []).map((diagram) => renderDiagram(diagram)).filter(Boolean).join('');
    if (!diagrams) return '';
    return `
      <section id="concept-diagrams" class="sm-section" aria-labelledby="diagrams-title">
        ${sectionHead('diagrams-title', '구조로 이해하기')}
        <div class="sm-diagrams">${diagrams}</div>
      </section>`;
  }

  // 이 화면은 빈출 개념을 **순서**로만 낸다 (plan.md §4.2, R5).
  // 집계 수치(N/M문항·평균 정답률·고난도 문항 수)는 전부 화면에서 걷어냈다 — 학습자가
  // 그 숫자로 내릴 결정이 없고, 표본이 선별 수록이라 오히려 오해를 만든다는 사용자 피드백을
  // 따랐다. 순서는 여전히 QUESTIONS에서 즉석 집계하므로 문항·태그가 바뀌면 저절로 따라간다.
  // 아이콘 사용 기준 — 나란히 놓인 블록의 **성격이 서로 다를 때**(설명 vs 경고) 그 구분에만 쓴다.
  // 아래 두 콜아웃이 사이트에서 아이콘이 남은 유일한 자리다. 항목마다 하나씩 붙는 아이콘은
  // 아무것도 구별해 주지 않으므로 다이어그램 노드·세부 개념에서 전부 걷어냈다 (DESIGN.md §4).
  // 시험장 판단 순서 — 예전의 '문제 푸는 순서'와 '기출 분석' 콜아웃을 한 섹션으로 합쳤다.
  // 둘 다 "무엇을 먼저 보고 무엇에 걸리는가"라는 같은 질문에 답한다.
  function renderDecisionFlow(note) {
    const steps = note.decision.map((step, index) => `<li><span>${index + 1}</span><p>${esc(step)}</p></li>`).join('');
    return `
      <section id="concept-flow" class="sm-section" aria-labelledby="decision-title">
        ${sectionHead('decision-title', '문제 풀이 기준')}
        <ol class="sm-steps">${steps}</ol>
        <div class="sm-callouts">
          <p class="sm-callout"><span class="kicker"><svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-info"></use></svg>수록 문항의 출제 방식</span>${esc(note.exam.trend)}</p>
          <p class="sm-callout is-trap"><span class="kicker"><svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-alert-triangle"></use></svg>자주 걸리는 함정</span>${esc(note.exam.trap)}</p>
        </div>
      </section>`;
  }

  function renderComparisonMatrix(note) {
    const headerCells = note.matrix.headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('');
    const bodyRows = note.matrix.rows.map((row) => `<tr>${row.map((cell, index) => index === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
    return `
      <section id="concept-compare" class="sm-section" aria-labelledby="comparison-title">
        ${sectionHead('comparison-title', note.matrix.title, '<span class="sm-sec-hint sm-swipe">좌우로 밀어 전체 보기</span>')}
        <div class="table-wrap sm-matrix-wrap" tabindex="0">
          <table class="table sm-matrix">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function renderRecallLab(note) {
    const recallItems = note.recall.map((item, index) => `
      <details class="sm-recall-item">
        <summary><span class="sm-recall-n num">${index + 1}</span><span>${esc(item.question)}</span></summary>
        <p>${esc(item.answer)}</p>
      </details>`).join('');
    return `
      <section id="recall-lab" class="sm-section" aria-labelledby="recall-title">
        ${sectionHead('recall-title', '스스로 확인하기', '<span class="sm-sec-hint">답을 생각한 뒤 펼치세요</span>')}
        <div class="sm-recall">${recallItems}</div>
        <p class="list-group-foot">복습 간격 · 오늘 · 1일 뒤 · 3일 뒤 · 7일 뒤</p>
      </section>`;
  }

  // 접힘 1 — 빈출 개념 순위와 판별 점검. 순위는 수록 기출에서 즉석 집계한다.
  function renderExamFold(id, note, sub) {
    const questions = QUESTIONS.filter((question) => question.sub === id);
    const tagRows = note.exam.tags
      .map((tag) => ({ tag, hits: questions.filter((question) => (question.tags || []).includes(tag)).length }))
      .sort((left, right) => right.hits - left.hits || left.tag.localeCompare(right.tag, 'ko'));
    const freq = tagRows.map(({ tag }) => `<li class="sm-freq-item">${esc(tag)}</li>`).join('');
    const visual = sub.visual || { question: '', flow: [], checks: [] };
    const flow = visual.flow.map((step, index) => `<li class="sm-flow-step"><span>${index + 1}</span>${esc(step)}</li>`).join('');
    const checks = visual.checks.map((line) => `<li>${esc(line)}</li>`).join('');
    return foldSection('exam-fold-title', '빈출 개념과 판별 점검', `${tagRows.length}개`, `
      <ol class="sm-freq" aria-label="개념 태그별 출제 빈도 순위">${freq}</ol>
      <p class="sm-lead">${esc(visual.question)}</p>
      <ol class="sm-flow" aria-label="판별 순서">${flow}</ol>
      <ul class="sm-bullets">${checks}</ul>
      <p class="list-group-foot">선별 수록 표본의 순위입니다. 전수 통계가 아닙니다.</p>`);
  }

  // 접힘 2 — 교과 개념 설명과 세부 개념. 둘 다 "더 파고들 때" 읽는 글이라 한 서랍에 넣는다.
  function renderDetailFold(sub, note) {
    const sections = sub.sections.map(renderConceptSection).join('');
    const deep = note.deepDive.map((item) => `
      <article class="sm-deep-item">
        <h3 class="title-3">${esc(item.term)}</h3>
        <ul class="sm-deep-points">${item.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>
      </article>`).join('');
    const count = sub.sections.length + note.deepDive.length;
    return foldSection('detail-fold-title', '세부 개념 설명', `${count}항목`, `
      <div class="sm-concept-grid">${sections}</div>
      <div class="sm-deep">${deep}</div>`);
  }

  // 접힘 3 — 학습 설계 근거. 학습자가 매번 읽을 글이 아니라 부록이다.
  function renderLearningDesign() {
    const steps = LEARNING_DESIGN.steps.map((step) => `
      <div class="list-row">
        <span class="list-row-body">
          <span class="list-row-title">${esc(step.label)}</span>
          <span class="list-row-sub">${esc(step.text)}</span>
        </span>
      </div>`).join('');
    const evidence = LEARNING_DESIGN.evidence.map((item) => `
      <a class="list-row list-row-nav" href="${esc(item.href)}" target="_blank" rel="noopener noreferrer">
        <span class="list-row-body">
          <span class="list-row-title">${esc(item.label)}</span>
          <span class="list-row-sub">${esc(item.text)}</span>
        </span>
      </a>`).join('');
    return foldSection('design-fold-title', LEARNING_DESIGN.title, '설계 근거', `
      <p class="sm-lead">${esc(LEARNING_DESIGN.summary)}</p>
      <div class="list-group is-inset">${steps}</div>
      <p class="list-group-head">근거 연구</p>
      <div class="list-group is-inset">${evidence}</div>
      <p class="list-group-foot">연구 결과는 학습 조건과 개인에 따라 달라질 수 있습니다.</p>`);
  }

  function renderConcept(id) {
    const sub = SUB_BY_ID.get(id);
    if (!sub) return renderHome();
    const note = NOTEBOOKS[id];
    if (!note) return renderHome();
    state.view = 'concept';
    state.concept = id;
    setNav('concept');
    const index = SUBUNITS.findIndex((subunit) => subunit.id === id);
    const questionCount = QUESTIONS.filter((question) => question.sub === id).length;
    app.innerHTML = `
      ${renderConceptNavigation(id, index, questionCount)}
      <header class="sm-concept-head">
        ${appIcon()}
        <div>
          <h1 class="title-1">${esc(sub.title)}</h1>
          <p class="sm-concept-meta">${esc(sub.unitTitle)} · 약 ${sub.time}분 · ${sub.unitId === 'V' ? '개념 연습' : '수록 기출'} ${questionCount}문항</p>
        </div>
      </header>
      <nav class="sm-reading-nav" aria-label="개념 노트 바로 가기">
        <a href="#concept-core">핵심 개념</a><a href="#concept-compare">비교표</a><a href="#concept-flow">풀이 기준</a><a href="#recall-lab">스스로 확인</a>
      </nav>
      <div class="sm-note-body">
        <div class="sm-study-main">
        ${renderCore(sub, note)}
        ${renderDiagramSection(note)}
        ${renderComparisonMatrix(note)}
        ${renderDetailFold(sub, note)}
        </div>
        <aside class="sm-study-review" aria-label="개념 복습">
        ${renderDecisionFlow(note)}
        ${renderRecallLab(note)}
        ${renderExamFold(id, note, sub)}
        ${renderLearningDesign()}
        </aside>
      </div>
      <div class="toolbar sm-concept-finish">
        <button id="markDone" class="btn btn-secondary btn-sm" type="button">
          ${db.completed[id] ? '개념 확인 완료됨' : '개념 확인 완료로 표시'}
        </button>
        <div class="toolbar-spacer"></div>
        <button id="nextConceptFoot" class="btn btn-ghost btn-sm" type="button" ${index === SUBUNITS.length - 1 ? 'disabled' : ''}>다음 중단원 →</button>
      </div>
      <p class="sm-source">개념 검토는 2027 학습 범위를 따랐습니다. 빈출 표시는 평가원 기출 78문항의 자동 집계이며 5단원에는 개념 연습 20문항을 더했습니다. 기출 문항 저작권은 한국교육과정평가원에 있습니다.</p>`;
    document.getElementById('conceptHome').addEventListener('click', renderHome);
    app.querySelectorAll('.sm-reading-nav a').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = app.querySelector(link.getAttribute('href'));
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    }));
    document.getElementById('prevConcept').addEventListener('click', () => renderConcept(SUBUNITS[index - 1]?.id));
    document.getElementById('nextConcept').addEventListener('click', () => renderConcept(SUBUNITS[index + 1]?.id));
    document.getElementById('nextConceptFoot').addEventListener('click', () => renderConcept(SUBUNITS[index + 1]?.id));
    document.getElementById('jumpConcept').addEventListener('change', (event) => renderConcept(event.target.value));
    document.getElementById('markDone').addEventListener('click', () => {
      db.completed[id] = Date.now();
      saveDb();
      renderConcept(id);
      showToast('개념 완료를 저장했습니다.');
    });
    document.getElementById('subQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.sub === id), `${id} 중단원`, 'all'));
  }
  function startQuiz(pool, label, countOverride, orderOverride = state.order) {
    if (!pool.length) return showToast('출제할 문제가 없습니다.');
    let qs = sortQuestions(pool, orderOverride);
    const count = countOverride || state.count;
    if (count !== 'all') qs = qs.slice(0, Math.min(Number(count), qs.length));
    state.session = {
      label,
      questions: qs,
      index: 0,
      answered: false,
      last: null,
      correct: 0,
      wrong: 0,
      results: [],
      startedAt: Date.now()
    };
    state.view = 'quiz';
    db.sessions++;
    saveDb();
    renderQuiz();
  }
  function submitAnswer(forcedInput) {
    const ss = state.session;
    if (!ss || ss.answered) return nextQuestion();
    const q = ss.questions[ss.index],
      input = forcedInput ?? document.getElementById('answerInput')?.value.trim() ?? '',
      judged = check(q, input);
    ss.answered = true;
    ss.last = {
      input,
      ...judged,
      overridden: false
    };
    if (judged.correct) ss.correct++;else ss.wrong++;
    ss.results.push({
      id: q.id,
      input,
      correct: judged.correct,
      overridden: false
    });
    record(q, input, judged);
    renderQuiz();
  }
  function nextQuestion() {
    const ss = state.session;
    if (!ss || !ss.answered) return;
    if (ss.index >= ss.questions.length - 1) {
      renderResult();
      return;
    }
    ss.index++;
    ss.answered = false;
    ss.last = null;
    renderQuiz();
  }
  function renderQuestionMedia(question, options = {}) {
    const { className = '', loading = 'eager' } = options;
    if (question.kind === 'practice') {
      return `<section class="sm-practice-question ${esc(className)}"><span class="badge badge-accent">5단원 개념 연습</span><h2>${esc(question.stem)}</h2></section>`;
    }
    const imageName = String(question.image || '').split('/').at(-1) || '';
    return `
      <figure class="sm-media ${esc(className)}">
        <a class="sm-media-link" href="${esc(question.source.question)}" target="_blank"
          rel="noopener" title="원문 PDF 열기">
          <img class="sm-media-img" data-question-image="${esc(imageName)}"
            alt="${esc(question.prompt)}의 제시문·보기·선지 전체 원문"
            loading="${loading}" decoding="async">
        </a>
        <figcaption>${question.year}학년도 ${esc(question.session)} ${question.number}번 · 제시문·보기·선지 전체를 원문 이미지로 제공합니다.</figcaption>
        <div class="sm-media-fallback" hidden>
          <strong>문제 이미지를 불러오지 못했습니다.</strong>
          <p>배포 지연이나 네트워크 오류일 수 있습니다. 평가원 원문 PDF에서 ${question.number}번을 확인해 주세요.</p>
          <a class="btn btn-secondary btn-sm" href="${esc(question.source.question)}" target="_blank" rel="noopener">원문 PDF 열기</a>
        </div>
      </figure>`;
  }
  function bindQuestionImages(root = document) {
    root.querySelectorAll('[data-question-image]').forEach(image => {
      const figure = image.closest('.sm-media');
      const link = image.closest('.sm-media-link');
      const fallback = figure?.querySelector('.sm-media-fallback');
      // 폴백은 '숨김 attribute + CSS 기본 display:none' 두 겹으로 잠겨 있다.
      // 상태 전환은 반드시 이 두 함수만 통해서 한다 (성공/실패 양방향 복원).
      const markFailed = () => {
        figure?.classList.add('is-failed');
        link?.classList.add('is-failed');
        if (fallback) fallback.hidden = false;
      };
      const markLoaded = () => {
        figure?.classList.remove('is-failed');
        link?.classList.remove('is-failed');
        if (fallback) fallback.hidden = true;
      };
      const loadProtectedImage = async () => {
        let objectUrl = '';
        try {
          const name = image.dataset.questionImage || '';
          if (!/^[a-z0-9-]+\.webp$/u.test(name)) throw new Error('invalid image name');
          const response = await window.HvsAccount.request(`/api/learning/smstudy/image/${encodeURIComponent(name)}`, {
            headers: { accept: 'image/webp' },
          });
          if (!response.ok) throw new Error('image unavailable');
          objectUrl = URL.createObjectURL(await response.blob());
          image.addEventListener('load', () => {
            markLoaded();
            URL.revokeObjectURL(objectUrl);
          }, { once: true });
          image.addEventListener('error', () => {
            markFailed();
            URL.revokeObjectURL(objectUrl);
          }, { once: true });
          image.src = objectUrl;
        } catch (error) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          if (error?.message !== 'unauthorized') markFailed();
        }
      };
      loadProtectedImage();
    });
  }
  function renderAnswerChoices(question, session, current, total) {
    const choices = CHOICE_MARKS.map((mark, index) => {
      const selected = session.answered && Number(session.last.input) === index;
      const className = session.answered && index === question.correct
        ? 'is-correct'
        : selected ? 'is-wrong' : '';
      const choiceText = question.choices?.[index] ? `<small>${esc(question.choices[index])}</small>` : '';
      return `
        <button class="choice-option sm-choice ${className}" type="button" data-index="${index}"
          aria-label="${index + 1}번" ${session.answered ? 'disabled' : ''}>
          <span>${mark}</span>${choiceText}
        </button>`;
    }).join('');

    const nextAction = session.answered
      ? `<button id="submitAnswer" class="btn btn-primary sm-full" type="button">${current === total ? '결과 보기' : '다음 문제'}</button>`
      : '<p class="sm-hint">키보드 1~5를 누르면 바로 채점됩니다.</p>';
    return `
      <div class="sm-answer">
        <p class="field-label">정답을 선택하세요.</p>
        <div class="sm-choices ${question.choices ? 'has-copy' : ''}" role="group" aria-label="선지 선택">${choices}</div>
        ${nextAction}
      </div>`;
  }

  function bindQuizEvents(question, session) {
    document.querySelectorAll('.choice-option').forEach((button) => {
      button.addEventListener('click', () => submitAnswer(button.dataset.index));
    });
    document.querySelectorAll('.reason-option').forEach((button) => {
      button.addEventListener('click', () => {
        const row = db.wrongBank[question.id];
        if (!row) return;
        row.reason = button.dataset.reason;
        saveDb();
        renderQuiz();
        showToast('오답 원인을 분석에 반영했습니다.');
      });
    });
    document.querySelectorAll('.mistake-concept').forEach((button) => button.addEventListener('click', () => renderConcept(button.dataset.sub)));
    const submit = document.getElementById('submitAnswer');
    if (submit) submit.addEventListener('click', session.answered ? nextQuestion : () => submitAnswer());
    if (session.answered) requestAnimationFrame(() => submit?.focus());
  }

  function renderQuiz() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'quiz';
    setNav('quiz');
    const question = session.questions[session.index];
    const subunit = SUB_BY_ID.get(question.sub);
    const current = session.index + 1;
    const total = session.questions.length;
    const progress = Math.round((current / total) * 100);
    const sourceLabel = question.kind === 'practice' ? '2027 개념 연습' : `${question.year}학년도 ${question.session} 기출 · 평가원`;
    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${appIcon()}
          <div>
            <span class="kicker">${esc(session.label)} · ${question.sub}</span>
            <h1>${question.kind === 'practice' ? '개념 연습' : '기출 풀이'}</h1>
          </div>
        </div>
        <span class="badge ${session.wrong ? 'badge-red' : 'badge-green'}">정답 ${session.correct} · 오답 ${session.wrong}</span>
      </header>

      <section class="sm-progress" aria-label="진행 상황">
        <div class="sm-progress-meta"><span>${current} / ${total}</span><span>${progress}%</span></div>
        <div class="sm-track"><div class="sm-fill" style="width:${progress}%"></div></div>
      </section>

      <article class="card card-xl sm-stack sm-question">
        <div class="view-head">
          <div>
            <span class="kicker">${question.kind === 'practice' ? '개념 적용' : '평가원 원문'} · ${esc(subunit.title)}</span>
            <p class="sm-note">${esc(sourceLabel)} · ${question.number}번</p>
          </div>
          <span class="badge badge-accent">정답률 ${question.correctRate}%</span>
        </div>
        ${renderQuestionMedia(question)}
        ${renderAnswerChoices(question, session, current, total)}
        ${session.answered ? renderFeedback(question, session.last) : ''}
      </article>`;
    bindQuestionImages(app);
    bindQuizEvents(question, session);
  }

  function renderExplanationGuide(question, result, compact = false) {
    const guide = EXPLANATION_GUIDES[question.sub];
    if (!guide) return '';
    const selectedAnswer = shownAnswer(question, result.input);
    const selectedLabel = selectedAnswer === '(선택 없음)' ? selectedAnswer : `${selectedAnswer}번`;
    const checks = guide.checks.map((checkItem) => `<li>${esc(checkItem)}</li>`).join('');
    return `
      <section class="sm-solution ${compact ? 'is-compact' : ''}" aria-label="문항 해설">
        <div class="sm-solution-head">
          <span class="badge badge-accent">${question.kind === 'practice' ? '개념 연습 해설' : '평가원 정답 · EBS 해설 방식'}</span>
          <small>${esc(guide.focus)}</small>
        </div>
        <div class="sm-reason is-correct">
          <h4 class="title-3">정답 ${question.answerNumber}번이 되는 판단</h4>
          <p>${esc(guide.correctReason)}</p>
        </div>
        ${result.correct ? '' : `
          <div class="sm-reason is-wrong">
            <h4 class="title-3">내가 고른 ${esc(selectedLabel)}이 아닌 이유</h4>
            <p>${esc(guide.wrongReason)}</p>
          </div>`}
        <div class="sm-solution-checks">
          <strong>${question.kind === 'practice' ? '개념에서 다시 확인할 것' : '원문 선지에서 다시 확인할 것'}</strong>
          <ul class="sm-bullets">${checks}</ul>
        </div>
        <p class="sm-solution-source">
          ${question.kind === 'practice' ? '<span>교과 개념을 바탕으로 만든 자체 연습 문항입니다. 평가원 기출 문항이 아닙니다.</span>' : `<span>정답 번호는 평가원 정답표와 대조했습니다. 풀이는 EBS의 ‘정답 해설·오답 피하기’ 방식으로 핵심 기준을 재구성했습니다.</span><a href="${esc(EBS_PAST_EXAMS)}" target="_blank" rel="noopener noreferrer">EBSi 기출 해설 찾기</a>`}
        </p>
      </section>`;
  }

  function renderWrongDiagnosis(question, result) {
    const subunit = SUB_BY_ID.get(question.sub);
    const savedReason = db.wrongBank[question.id]?.reason || '';
    const reasonButtons = Object.entries(MISTAKE_REASONS).map(([key, label]) => `
      <button class="segmented-btn reason-option ${savedReason === key ? 'is-active' : ''}"
        data-reason="${key}" type="button">${esc(label)}</button>
    `).join('');
    return `
      <div class="sm-diagnosis">
        <strong>${esc(question.sub)} · ${esc(subunit.title)}에서 틀렸습니다.</strong>
        <p>위 해설과 원문 선지를 대조한 뒤 실제 실수 원인을 남기세요. 번호가 아니라 판단 기준을 복습 기록에 저장합니다.</p>
        <div class="segmented sm-reasons" role="group" aria-label="오답 원인 선택">${reasonButtons}</div>
      </div>`;
  }

  function renderFeedback(question, result) {
    const modifier = result.correct ? 'is-correct' : 'is-wrong';
    const title = result.correct ? '정답' : '오답';
    return `
      <div class="sm-feedback ${modifier}" role="status">
        <p class="sm-feedback-head">${title}</p>
        <div class="sm-feedback-grid">
          <div class="sm-feedback-cell"><small>${question.kind === 'practice' ? '정답' : '평가원 정답'}</small><strong>${esc(question.answer)}</strong></div>
          <div class="sm-feedback-cell"><small>내 답</small><strong>${esc(shownAnswer(question, result.input))}</strong></div>
        </div>
        <p class="sm-note">${question.kind === 'practice' ? '5단원 핵심 개념을 기준으로 만든 연습 문항입니다.' : `평가원 원문 정답표와 대조한 답입니다. 통사랑 문항별 집계 정답률은 ${question.correctRate}%입니다.`}</p>
        ${renderExplanationGuide(question, result)}
        ${result.correct ? '' : renderWrongDiagnosis(question, result)}
        ${question.kind === 'practice' ? `<div class="sm-links"><button class="btn btn-secondary btn-sm mistake-concept" type="button" data-sub="${question.sub}">개념 지도 다시 보기</button></div>` : `<div class="sm-links"><a class="btn btn-secondary btn-sm" href="${esc(question.source.question)}" target="_blank" rel="noopener">문제 원문 PDF</a><a class="btn btn-secondary btn-sm" href="${esc(question.source.answer)}" target="_blank" rel="noopener">정답표 확인</a><a class="btn btn-secondary btn-sm" href="https://tongsarang.kr/" target="_blank" rel="noopener">정답률 출처</a></div>`}
      </div>`;
  }

  function renderMistakeCard(question, info = {}, input) {
    const subunit = SUB_BY_ID.get(question.sub);
    const selected = input === undefined || input === null
      ? info.lastAnswer || '(선택 없음)'
      : shownAnswer(question, input);
    const reason = MISTAKE_REASONS[info.reason] || '원인 미분류';
    const repeatCopy = (info.count || 1) >= 2
      ? '같은 문항을 반복해서 틀렸습니다. 정답 번호보다 선지를 가르는 개념 기준부터 다시 확인하세요.'
      : '첫 오답입니다. 내 답과 정답 선지의 표현 차이를 표시한 뒤 개념 지도로 돌아가세요.';
    return `
      <article class="card sm-stack sm-mistake">
        <div class="view-head">
          <div>
            <span class="badge badge-red">누적 오답 ${info.count || 1}회 · 출제 정답률 ${question.correctRate}%</span>
            <h3 class="title-3">${question.sub} · ${esc(subunit.title)}</h3>
            <p class="sm-note">${question.kind === 'practice' ? `2027 개념 연습 ${question.number}번` : `${question.year}학년도 ${esc(question.session)} ${question.number}번 · 평가원`}</p>
          </div>
          <span class="badge badge-orange">${esc(reason)}</span>
        </div>
        ${renderQuestionMedia(question, { className: 'is-review', loading: 'lazy' })}
        <div class="sm-compare">
          <div><small>최근 내 답</small><strong class="sm-answer-wrong">${esc(selected)}</strong></div>
          <span aria-hidden="true">→</span>
          <div><small>${question.kind === 'practice' ? '정답' : '평가원 정답'}</small><strong class="sm-answer-correct">${esc(question.answer)}</strong></div>
        </div>
        ${renderExplanationGuide(question, { input, correct: false }, true)}
        <div class="sm-diagnosis">
          <strong>${esc(subunit.unitId)}단원 · ${esc(subunit.title)} 취약 신호</strong>
          <p>${esc(repeatCopy)}</p>
          <small>핵심 판별어: ${esc(subunit.keywords)}</small>
        </div>
        <div class="sm-links">
          <button class="btn btn-secondary btn-sm mistake-concept" type="button" data-sub="${question.sub}">개념 지도 다시 보기</button>
          <button class="btn btn-ghost btn-sm mistake-retry" type="button" data-id="${question.id}">이 문제 재시험</button>
          ${question.kind === 'practice' ? '' : `<a class="btn btn-secondary btn-sm" href="${esc(question.source.answer)}" target="_blank" rel="noopener">정답표</a>`}
        </div>
      </article>`;
  }
  function bindMistakeActions(root = app) {
    bindQuestionImages(root);
    root.querySelectorAll('.mistake-concept').forEach(button => button.addEventListener('click', () => renderConcept(button.dataset.sub)));
    root.querySelectorAll('.mistake-retry').forEach(button => button.addEventListener('click', () => {
      const q = Q_BY_ID.get(button.dataset.id);
      if (q) startQuiz([q], '오답 1문제 재시험', 'all');
    }));
  }
  function renderResult() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'result';
    setNav('result');
    const total = session.questions.length;
    const accuracy = Math.round((session.correct / total) * 100);
    const wrongResults = session.results.filter((result) => !result.correct);
    const mistakeCards = wrongResults.map((result) => {
      const question = Q_BY_ID.get(result.id);
      return renderMistakeCard(question, db.wrongBank[question.id], result.input);
    }).join('');
    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${appIcon()}
          <div>
            <span class="kicker">${esc(session.label)} 완료</span>
            <h1>풀이 결과</h1>
          </div>
        </div>
      </header>

      <section class="card card-xl sm-stack sm-result">
        <div>
          <div class="sm-score">${accuracy}%</div>
          <p class="text-secondary">${total}문제 중 ${session.correct}개 정답 · 오답 ${session.wrong}개</p>
        </div>
        <div class="sm-actions">
          <button id="retryResult" class="btn btn-primary" type="button" ${wrongResults.length ? '' : 'disabled'}>이번 오답 다시 풀기</button>
          <button id="resultHome" class="btn btn-secondary" type="button">단원 목록</button>
        </div>
      </section>

      ${wrongResults.length ? `
        <section class="sm-stack" aria-labelledby="resultMistakes">
          <div>
            <h2 class="title-2" id="resultMistakes">이번 오답 ${wrongResults.length}문제</h2>
            <p class="sm-note">문제 원문과 선지 전체를 다시 보고, 내 답과 정답을 가른 기준을 확인하세요.</p>
          </div>
          <div class="sm-mistakes">${mistakeCards}</div>
        </section>
      ` : '<p class="sm-empty">완벽합니다. 이 범위의 오답은 모두 정리됐습니다.</p>'}`;
    document.getElementById('resultHome').addEventListener('click', renderHome);
    document.getElementById('retryResult').addEventListener('click', () => {
      const retryQuestions = wrongResults.map((result) => Q_BY_ID.get(result.id)).filter(Boolean);
      startQuiz(retryQuestions, '이번 오답 재시험', 'all');
    });
    bindMistakeActions();
  }
  function renderAnalysisMeter(accuracy, label = '') {
    const value = accuracy ?? 0;
    return `
      <div class="sm-meter" role="img" aria-label="${esc(label || `${value}%`)}">
        <span style="width:${value}%"></span>
      </div>`;
  }

  function renderWeaknessPanel(analysis) {
    const weakestUnit = analysis.weakestUnit
      ? `${analysis.weakestUnit.id} · ${analysis.weakestUnit.accuracy}%`
      : '풀이 기록 필요';
    const weakestSubunit = analysis.weakestSub
      ? `${analysis.weakestSub.id} · ${analysis.weakestSub.accuracy}%`
      : '풀이 기록 필요';
    const reasonSummary = analysis.dominantReason
      ? `${analysis.dominantReason.label} · ${analysis.dominantReason.count}문제`
      : '오답 원인 없음';
    const unitRows = analysis.unitRows.map((row) => renderRateRow(
      row.attempts ? `${row.attempts}회 풀이 · ${masteryLabel(row)}` : '아직 풀이 없음',
      row,
    )).join('');
    return `
      <section class="sm-stack sm-section" aria-labelledby="weaknessTitle">
        <h2 class="list-group-head" id="weaknessTitle">내 약점</h2>
        <div class="list-group">
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">가장 취약한 대단원</span></span>
            <span class="list-row-value">${esc(weakestUnit)}</span>
          </div>
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">가장 취약한 중단원</span></span>
            <span class="list-row-value">${esc(weakestSubunit)}</span>
          </div>
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">가장 많은 실수 원인</span></span>
            <span class="list-row-value">${esc(reasonSummary)}</span>
          </div>
        </div>
        <p class="list-group-head">대단원별 정확도</p>
        <div class="list-group">${unitRows}</div>
        <p class="list-group-foot">3회 미만 기록은 표본 부족으로 표시합니다.</p>
      </section>`;
  }

  function renderRateRow(sub, row) {
    const title = `${row.id} · ${row.title}`;
    return `
      <div class="list-row sm-rate">
        <span class="list-row-body">
          <span class="list-row-title">${esc(title)}</span>
          <span class="list-row-sub">${esc(sub)}</span>
        </span>
        ${renderAnalysisMeter(row.accuracy, `${title} 정확도`)}
        <span class="list-row-value num">${row.accuracy === null ? '-' : `${row.accuracy}%`}</span>
      </div>`;
  }

  function renderSubunitStats(analysis) {
    const rows = analysis.subRows.map((row) => renderRateRow(
      `${db.completed[row.id] ? '개념 완료' : '개념 미완료'} · ${masteryLabel(row)}`,
      row,
    )).join('');
    return `
      <section class="sm-stack sm-section sm-record-section" aria-labelledby="subStatsTitle">
        <h2 class="list-group-head" id="subStatsTitle">중단원별 현황</h2>
        <div class="list-group">${rows}</div>
      </section>`;
  }

  function getWrongEntries(order = state.wrongOrder) {
    const questions = Object.keys(db.wrongBank)
      .map((id) => Q_BY_ID.get(id))
      .filter(Boolean);
    return sortQuestions(questions, order)
      .map((question) => ({ question, info: db.wrongBank[question.id] }));
  }

  function renderWrongNote(wrongEntries) {
    const disclosures = wrongEntries.map(({ question, info }) => {
      const subunit = SUB_BY_ID.get(question.sub);
      return `
        <details class="disclosure sm-mistake-disclosure" data-mistake-id="${esc(question.id)}">
          <summary class="disclosure-head">
            <span class="disclosure-title">${question.year}학년도 ${esc(question.session)} ${question.number}번 · ${esc(subunit.title)}</span>
            <span class="disclosure-hint">오답 ${info.count || 1}회</span>
          </summary>
          <div class="disclosure-body" data-mistake-body></div>
        </details>`;
    }).join('');
    return `
      <section class="sm-stack sm-section sm-record-section" aria-labelledby="wrongNoteTitle">
        <div class="view-head">
          <div>
            <h2 class="title-2" id="wrongNoteTitle">오답 원문 분석 노트</h2>
            <p class="sm-note">${wrongEntries.length}문제 · 출제 정답률이나 내 최근 풀이 기록으로 정렬합니다.</p>
          </div>
          <div class="toolbar-group">
            <label class="field-label" for="wrongSortMode">정렬</label>
            <select id="wrongSortMode" class="field-input">${renderSortOptions(state.wrongOrder)}</select>
            <button id="statsReview" class="btn btn-primary btn-sm" type="button" ${wrongEntries.length ? '' : 'disabled'}>전체 재시험</button>
          </div>
        </div>
        ${wrongEntries.length ? `<div class="sm-mistakes">${disclosures}</div>` : '<p class="sm-empty">아직 오답이 없습니다.</p>'}
      </section>`;
  }

  function bindMistakeDisclosures() {
    app.querySelectorAll('[data-mistake-id]').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.loaded === 'true') return;
        const question = Q_BY_ID.get(details.dataset.mistakeId);
        const info = db.wrongBank[details.dataset.mistakeId];
        const body = details.querySelector('[data-mistake-body]');
        if (!question || !info || !body) return;
        body.innerHTML = renderMistakeCard(question, info, info.lastInput);
        details.dataset.loaded = 'true';
        bindMistakeActions(details);
      });
    });
  }

  function renderStats() {
    state.view = 'stats';
    state.session = null;
    setNav('stats');
    const summary = stats();
    const analysis = weaknessAnalysis();
    const wrongEntries = getWrongEntries();
    app.innerHTML = `
      <header class="view-head">
        <div class="view-head-main">
          ${appIcon()}
          <div>
            <h1>학습 기록</h1>
            <p>정답 번호가 아니라 원문·오답 원인·단원별 정확도를 함께 봅니다.</p>
          </div>
        </div>
        <button id="statsHome" class="btn btn-secondary btn-sm" type="button">단원 목록</button>
      </header>

      <section class="card sm-stack" aria-label="누적 지표">
        <div class="sm-metrics">
          <div class="stat"><span class="stat-value">${db.attempts}</span><span class="stat-label">총 풀이</span></div>
          <div class="stat"><span class="stat-value">${summary.accuracy}%</span><span class="stat-label">정답률</span></div>
          <div class="stat"><span class="stat-value">${summary.wrong}</span><span class="stat-label">현재 오답</span></div>
        </div>
      </section>

      <div class="toolbar" role="group" aria-label="기록 데이터 관리">
        <div class="toolbar-group">
          <button id="exportData" class="btn btn-secondary btn-sm" type="button">기록 백업</button>
          <label class="btn btn-secondary btn-sm" for="importData">기록 복원</label>
          <input id="importData" class="sr-only" type="file" accept="application/json,.json">
        </div>
        <div class="toolbar-spacer"></div>
        <button id="resetData" class="btn btn-danger btn-sm" type="button">기록 초기화</button>
      </div>

      ${renderWeaknessPanel(analysis)}
      ${renderSubunitStats(analysis)}
      ${renderWrongNote(wrongEntries)}`;
    document.getElementById('statsHome').addEventListener('click', renderHome);
    document.getElementById('wrongSortMode').addEventListener('change', (event) => {
      state.wrongOrder = event.target.value;
      renderStats();
    });
    document.getElementById('statsReview').addEventListener('click', () => {
      startQuiz(wrongEntries.map(({ question }) => question), '오답 재시험', 'all', state.wrongOrder);
    });
    document.getElementById('exportData').addEventListener('click', exportData);
    document.getElementById('importData').addEventListener('change', importData);
    document.getElementById('resetData').addEventListener('click', resetData);
    bindMistakeDisclosures();
  }
  function exportData() {
    const blob = new Blob([JSON.stringify({
        app: 'samun2027-study',
        ...db
      }, null, 2)], {
        type: 'application/json;charset=utf-8'
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = `samun-2027-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('학습 기록을 백업했습니다.');
  }
  async function importData(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (p.app !== 'samun2027-study' || p.version !== 1) throw new Error();
      db = {
        ...blankDb(),
        ...p,
        completed: p.completed || {},
        qStats: p.qStats || {},
        wrongBank: p.wrongBank || {},
        customAliases: p.customAliases || {}
      };
      saveDb();
      renderStats();
      showToast('기록을 복원했습니다.');
    } catch {
      showToast('이 앱의 올바른 백업 파일이 아닙니다.');
    } finally {
      e.target.value = '';
    }
  }
  function resetData() {
    if (!confirm('사회·문화 개념 완료, 정답률과 오답 기록을 모두 삭제할까요?')) return;
    db = blankDb();
    saveDb();
    renderStats();
    showToast('사회·문화 학습 기록을 초기화했습니다.');
  }
  function goHome() {
    if (state.view === 'quiz' && state.session?.index > 0 && !confirm('진행 중인 퀴즈를 끝내고 단원 목록으로 갈까요?')) return;
    renderHome();
  }
  document.getElementById('homeLogo').addEventListener('click', goHome);
  document.getElementById('openStats').addEventListener('click', () => {
    if (state.view === 'quiz' && !confirm('진행 중인 퀴즈를 끝내고 기록을 볼까요?')) return;
    renderStats();
  });
  // 접힌 섹션은 인쇄물에서 통째로 사라진다. 인쇄 직전에 강제로 펼치고 끝나면 되돌린다.
  // 인쇄 팔레트(@media print)와는 독립적인 경로이며, 팔레트 전환을 건드리지 않는다.
  function setFoldsOpen(open) {
    app.querySelectorAll('details[data-print-open]').forEach((element) => {
      if (open) {
        element.dataset.wasOpen = element.open ? '1' : '';
        element.open = true;
      } else {
        element.open = element.dataset.wasOpen === '1';
      }
    });
  }
  window.addEventListener?.('beforeprint', () => setFoldsOpen(true));
  window.addEventListener?.('afterprint', () => setFoldsOpen(false));

  document.addEventListener('keydown', e => {
    if (/^[1-5]$/.test(e.key) && state.view === 'quiz' && !state.session?.answered) {
      e.preventDefault();
      submitAnswer(Number(e.key) - 1);
      return;
    }
    if (e.key === 'Enter' && state.view === 'quiz' && state.session?.answered) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      nextQuestion();
    }
  });
  if (SUBUNITS.length !== EXPECTED_SUBUNIT_COUNT || QUESTIONS.length !== EXPECTED_QUESTION_COUNT) {
    app.innerHTML = `<div class="card"><h2>데이터 검증 오류</h2><p>소단원 ${SUBUNITS.length}개, 문제 ${QUESTIONS.length}개가 로드되었습니다.</p></div>`;
  } else renderHome();
  }

  const ready = window.SMSTUDY_CONTENT_READY;
  if (ready) {
    ready.then(start).catch((error) => {
      if (error?.message !== 'unauthorized') {
        app.innerHTML = '<div class="card"><h2>데이터 로드 오류</h2><p>사회·문화 학습 데이터를 불러오지 못했습니다.</p></div>';
      }
    });
  } else {
    start();
  }
})();
