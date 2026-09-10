// 정시 진단 화면 컨트롤러 (/ipsi/).
//
// 계약
//   - 데이터는 data.js(window.IPSI_DATA), 계산은 engine.js(window.IPSI_ENGINE)다. 이 파일은 상태·렌더·
//     바인딩만 한다. 렌더러는 상태 → HTML 문자열인 순수 함수이고 window.IPSI_RENDER로 노출해
//     scripts/snapshot.mjs가 같은 마크업을 얼린다.
//   - 성적은 이 브라우저의 localStorage에만 저장한다(계정 동기화 없음 — account.js는 게이트 전용).
//   - 미로그인은 렌더 전에 랜딩으로 되돌린다. 화면 어휘는 system.css 프리미티브(그룹 리스트·툴바·
//     세그먼티드·뱃지·접힘 그룹)만 소비한다(DESIGN.md §7). 이모지·채움 아이콘 없음(§5).
(() => {
  'use strict';

  const STORAGE_KEY = 'hvsdcm.ipsi.profile.v1';
  const PAGE = 40;
  const TRACKS = ['전체', '인문', '자연', '의약', '자유전공', '예체능'];
  const BAND_BADGE = { safe: 'badge-green', fit: 'badge-accent', reach: '', stretch: 'badge-orange', risky: 'badge-red' };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = (id) => `<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#${id}"></use></svg>`;
  const fmt = (value, digits = 1) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-');
  const signed = (value, digits = 1) => (typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}` : '-');
  const badge = (band) => (band ? `<span class="badge ${BAND_BADGE[band.key] || ''}">${esc(band.label)}</span>` : '');

  function loginPath() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return `/?login=1&next=${next}`;
  }

  // ---- 상태 ---------------------------------------------------------------
  function defaultState() {
    return {
      view: 'scores',
      input: {
        mode: 'pct', korElective: '화법과작문', mathElective: '미적분', kor: '', math: '', eng: '', hist: '',
        inq1Subject: '사회문화', inq1: '', inq2Subject: '생활과윤리', inq2: '', gpa: '',
      },
      filters: { track: '전체', line: '전체', band: '전체', query: '' },
      shown: {},
      target: { university: '', dept: '' },
      rulesUniversity: '',
    };
  }
  function loadState() {
    const state = defaultState();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        Object.assign(state.input, saved.input || {});
        Object.assign(state.filters, saved.filters || {});
        Object.assign(state.target, saved.target || {});
        state.rulesUniversity = saved.rulesUniversity || '';
      }
    } catch { /* 저장값이 깨졌으면 기본값으로 간다. */ }
    return state;
  }
  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ input: state.input, filters: state.filters, target: state.target, rulesUniversity: state.rulesUniversity }));
    } catch { /* 저장 실패는 화면을 막지 않는다. */ }
  }

  // ---- 렌더러 (순수 함수) ---------------------------------------------------
  function header(id, title, sub, action = '') {
    return `<header class="view-head"><div class="view-head-main">${icon(id)}<div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div></div>${action}</header>`;
  }
  function options(list, selected, labelOf = (value) => value) {
    return list.map((value) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(labelOf(value))}</option>`).join('');
  }
  function gradeOptions(selected) {
    return `<option value=""${selected === '' ? ' selected' : ''}>-</option>${options([1, 2, 3, 4, 5, 6, 7, 8, 9], selected, (grade) => `${grade}등급`)}`;
  }
  function inquiryOptions(engine, selected) {
    const group = (label, list) => `<optgroup label="${label}">${options(list, selected)}</optgroup>`;
    return group('사회탐구', engine.SOCIAL_SUBJECTS) + group('과학탐구', engine.SCIENCE_SUBJECTS);
  }
  function inputRow(title, controls) {
    return `<div class="list-row ip-input-row"><span class="list-row-body"><span class="list-row-title">${esc(title)}</span></span><span class="ip-controls">${controls}</span></div>`;
  }
  function relativeInput(name, value, mode) {
    const attrs = mode === 'grade' ? 'min="1" max="9" step="1" placeholder="등급"' : 'min="0" max="100" step="0.5" placeholder="백분위"';
    return `<input class="field-input-inline" type="number" inputmode="decimal" name="${name}" ${attrs} aria-label="${name} ${mode === 'grade' ? '등급' : '백분위'}" value="${esc(value)}">`;
  }

  function renderScores(state, data, engine) {
    const input = state.input;
    const profile = engine.normalizeProfile(input, data.scales);
    const complete = engine.profileComplete(profile);
    const average = engine.simpleAverage(profile);
    const mode = input.mode === 'grade' ? 'grade' : 'pct';
    const unit = mode === 'grade' ? '등급' : '백분위';
    return `<div class="ip-view">
      ${header('icon-pen', '성적 입력', '모의고사·수능 성적표의 값을 그대로 넣습니다.', `<button class="btn btn-primary" type="button" data-go="diagnose"${complete ? '' : ' disabled'}>진단 보기</button>`)}
      <section class="ip-section" aria-labelledby="ipInputHead">
        <h2 class="list-group-head" id="ipInputHead">수능 성적 · ${esc(unit)}</h2>
        <div class="list-group">
          ${inputRow('입력 기준', `<div class="segmented" role="group" aria-label="입력 기준"><button class="segmented-btn" type="button" data-mode="pct" aria-pressed="${mode === 'pct'}">백분위</button><button class="segmented-btn" type="button" data-mode="grade" aria-pressed="${mode === 'grade'}">등급</button></div>`)}
          ${inputRow('국어', `<select class="field-input-inline" name="korElective" aria-label="국어 선택과목">${options(engine.KOR_ELECTIVES, input.korElective)}</select>${relativeInput('kor', input.kor, mode)}`)}
          ${inputRow('수학', `<select class="field-input-inline" name="mathElective" aria-label="수학 선택과목">${options(engine.MATH_ELECTIVES, input.mathElective)}</select>${relativeInput('math', input.math, mode)}`)}
          ${inputRow('영어', `<select class="field-input-inline" name="eng" aria-label="영어 등급">${gradeOptions(String(input.eng ?? ''))}</select>`)}
          ${inputRow('한국사', `<select class="field-input-inline" name="hist" aria-label="한국사 등급">${gradeOptions(String(input.hist ?? ''))}</select>`)}
          ${inputRow('탐구 1', `<select class="field-input-inline" name="inq1Subject" aria-label="탐구 1 과목">${inquiryOptions(engine, input.inq1Subject)}</select>${relativeInput('inq1', input.inq1, mode)}`)}
          ${inputRow('탐구 2', `<select class="field-input-inline" name="inq2Subject" aria-label="탐구 2 과목">${inquiryOptions(engine, input.inq2Subject)}</select>${relativeInput('inq2', input.inq2, mode)}`)}
        </div>
        <p class="list-group-foot">등급 입력은 각 등급 구간의 중앙 백분위로 환산합니다. 국어·수학·탐구 2과목이 있어야 진단이 됩니다.</p>
      </section>
      <section class="ip-section" aria-labelledby="ipGpaHead">
        <h2 class="list-group-head" id="ipGpaHead">내신 · 참고</h2>
        <div class="list-group">
          ${inputRow('학생부 평균 등급', `<input class="field-input-inline" type="number" inputmode="decimal" name="gpa" min="1" max="9" step="0.01" placeholder="예: 2.35" aria-label="학생부 평균 등급" value="${esc(input.gpa)}">`)}
        </div>
        <p class="list-group-foot">정시 진단에는 쓰지 않고, 목표 학과 화면의 수시 컷과만 비교합니다.</p>
      </section>
      <section class="ip-section" aria-labelledby="ipSummaryHead">
        <h2 class="list-group-head" id="ipSummaryHead">요약</h2>
        <div class="list-group">
          <div class="list-row"><span class="list-row-body"><span class="list-row-title">국·수·탐(2) 백분위 평균</span></span><span class="list-row-value num">${fmt(average, 2)}</span></div>
          <div class="list-row"><span class="list-row-body"><span class="list-row-title">환산 등급 (국어 · 수학 · 탐구)</span></span><span class="list-row-value num">${[profile.kor.pct, profile.math.pct, engine.inquiryPercentile(profile, 2)].map((pct) => (engine.gradeFromPercentile(pct) ?? '-')).join(' · ')}</span></div>
          <div class="list-row"><span class="list-row-body"><span class="list-row-title">탐구 조합</span></span><span class="list-row-value">${profile.inquiries.length ? esc(profile.inquiries.map((row) => `${row.subject}(${row.kind === 'science' ? '과' : '사'})`).join(' · ')) : '-'}</span></div>
        </div>
      </section>
    </div>`;
  }

  function lineOptions(data, selected) {
    return `<option value="전체"${selected === '전체' ? ' selected' : ''}>모든 라인</option>${options(data.lines.map((line) => line.label), selected)}`;
  }

  function diagnoseRows(state, data, engine) {
    const profile = engine.normalizeProfile(state.input, data.scales);
    if (!engine.profileComplete(profile)) return { profile, groups: null };
    const filters = state.filters;
    const universities = filters.line === '전체' ? null : new Set((data.lines.find((line) => line.label === filters.line) || { ids: [] }).ids);
    const query = String(filters.query || '').trim().toLowerCase();
    const rows = engine.diagnose(profile, data, { track: filters.track, universities })
      .filter((row) => row.jeongsi.status !== 'no-cut')
      .filter((row) => !query || `${row.universityName}${row.dept.name}`.toLowerCase().includes(query));
    const groups = new Map();
    for (const row of rows) {
      const key = row.jeongsi.status === 'blocked' ? 'blocked' : row.jeongsi.band.key;
      if (filters.band !== '전체' && key !== filters.band) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return { profile, groups, total: rows.length };
  }

  function renderDiagnose(state, data, engine) {
    const { profile, groups, total } = diagnoseRows(state, data, engine);
    const filters = state.filters;
    const toolbar = `<div class="toolbar ip-toolbar" role="group" aria-label="진단 필터">
      <select class="field-input field-input-sm" name="track" aria-label="계열">${options(TRACKS, filters.track, (track) => (track === '전체' ? '모든 계열' : track))}</select>
      <select class="field-input field-input-sm" name="line" aria-label="대학 라인">${lineOptions(data, filters.line)}</select>
      <select class="field-input field-input-sm" name="band" aria-label="판정">${options(['전체', ...engine.VERDICT_BANDS.map((band) => band.key), 'blocked'], filters.band, (key) => (key === '전체' ? '모든 판정' : key === 'blocked' ? '지원 불가' : engine.VERDICT_BANDS.find((band) => band.key === key).label))}</select>
      <label class="sr-only" for="ipQuery">대학·학과 검색</label><input id="ipQuery" class="field-input field-input-sm" type="search" name="query" placeholder="대학·학과 검색" autocomplete="off" value="${esc(filters.query)}">
    </div>`;
    if (!groups) {
      return `<div class="ip-view">${header('icon-target', '지원 진단', '')}${toolbar}<p class="ip-empty">국어·수학·탐구 성적을 먼저 입력해야 진단할 수 있습니다.</p></div>`;
    }
    const order = ['safe', 'fit', 'reach', 'stretch', 'risky', 'blocked'];
    const labelOf = (key) => (key === 'blocked' ? '지원 불가' : engine.VERDICT_BANDS.find((band) => band.key === key).label);
    const sections = order.filter((key) => groups.has(key)).map((key) => {
      const rows = groups.get(key);
      const shown = Math.min(rows.length, state.shown[key] || PAGE);
      const items = rows.slice(0, shown).map((row) => {
        const result = row.jeongsi;
        const cutLabel = `${result.cut.year} ${result.cut.kind || '70%컷'} ${fmt(result.cut.value)}`;
        const spread = result.spread ? ` · 변동 ±${fmt(result.spread)}` : '';
        const group = result.group ? `${result.group}군 · ` : '';
        return `<button type="button" class="list-row list-row-nav" data-target="${esc(row.universityId)}|${esc(row.dept.name)}"><span class="list-row-body"><span class="list-row-title">${esc(row.universityName)} · ${esc(row.dept.name)}</span><span class="list-row-sub">${group}${esc(row.dept.track)} · 컷 ${cutLabel}${spread}</span></span><span class="ip-row-value"><span class="list-row-value num">${fmt(result.mine)} (${signed(result.gap)})</span>${key === 'blocked' ? '<span class="badge badge-red">불가</span>' : badge(result.band)}</span></button>`;
      }).join('');
      const more = rows.length > shown ? `<button class="btn btn-secondary btn-sm ip-more" type="button" data-more="${key}">${rows.length - shown}개 더 보기</button>` : '';
      return `<section class="ip-section" aria-labelledby="ipBand-${key}"><h2 class="list-group-head" id="ipBand-${key}">${esc(labelOf(key))} · ${rows.length}</h2><div class="list-group">${items}</div>${more}</section>`;
    }).join('');
    const summary = `내 국·수·탐 백분위 평균 ${fmt(engine.simpleAverage(profile), 2)} · 대상 ${total}개 모집단위`;
    return `<div class="ip-view">${header('icon-target', '지원 진단', summary)}${toolbar}${sections || '<p class="ip-empty">조건에 맞는 모집단위가 없습니다.</p>'}</div>`;
  }

  function findDept(data, universityId, deptName) {
    const university = data.universities.find((item) => item.id === universityId) || null;
    const dept = university?.departments.find((item) => item.name === deptName) || null;
    return { university, dept };
  }

  function ruleSummary(rule, deptTrack, ruleTrack, engine) {
    const track = engine.pickTrack(rule, deptTrack, ruleTrack);
    if (!track) return '반영 방법 미확인';
    const weights = track.weights || {};
    const parts = [];
    const bestOf = Array.isArray(track.bestOf) ? track.bestOf : [];
    for (const group of bestOf) parts.push(`${group.areas.map((area) => engine.SUBJECT_LABEL[area]).join('·')} 우수순 ${group.weights.join('·')}`);
    for (const key of ['kor', 'math', 'eng', 'inq']) if (Number(weights[key]) > 0) parts.push(`${engine.SUBJECT_LABEL[key]} ${weights[key]}`);
    const english = track.english?.method && track.english.method !== '비율반영' ? ` · 영어 ${track.english.method}` : '';
    return `${track.name} ${parts.join(' · ')}${track.unit === 'points' ? '점' : '%'}${english}`;
  }

  function renderTarget(state, data, engine) {
    const universityId = state.target.university || data.universities[0]?.id || '';
    const university = data.universities.find((item) => item.id === universityId) || data.universities[0];
    const dept = university?.departments.find((item) => item.name === state.target.dept) || university?.departments[0] || null;
    const picker = `<div class="toolbar ip-toolbar" role="group" aria-label="목표 선택">
      <select class="field-input field-input-sm" name="targetUniversity" aria-label="대학">${options(data.universities.map((item) => item.id), university?.id, (id) => data.universities.find((item) => item.id === id).short)}</select>
      <select class="field-input field-input-sm" name="targetDept" aria-label="학과">${options((university?.departments || []).map((item) => item.name), dept?.name)}</select>
    </div>`;
    if (!university || !dept) return `<div class="ip-view">${header('icon-bookmark', '목표 학과', '')}${picker}<p class="ip-empty">선택한 대학의 정시 결과가 없습니다.</p></div>`;
    const rule = data.rules[university.id];
    const profile = engine.normalizeProfile(state.input, data.scales);
    const result = engine.analyzeTarget(profile, university, dept, rule);
    const title = `${university.short} ${dept.name}`;
    const reference = result.reference;
    const history = reference.history.map((row) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(row.year)}학년도 ${esc(row.kind)}${row.group ? ` · ${esc(row.group)}군` : ''}</span></span><span class="list-row-value num">${fmt(row.value)}</span></div>`).join('');
    const latest = dept.jeongsi[reference.primary?.year] || {};
    const facts = `<section class="ip-section" aria-labelledby="ipFactHead"><h2 class="list-group-head" id="ipFactHead">기준</h2><div class="list-group">
      ${history || '<div class="list-row"><span class="list-row-body"><span class="list-row-title">백분위 컷 미공개(환산점수만 공개)</span></span></div>'}
      ${latest.quota ? `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(reference.primary.year)} 모집인원 · 경쟁률 · 충원</span></span><span class="list-row-value num">${esc(latest.quota)}명 · ${fmt(latest.rate, 2)} · ${latest.fill ?? '-'}</span></div>` : ''}
      <div class="list-row"><span class="list-row-body"><span class="list-row-title">2027 반영 방법</span><span class="list-row-sub">${esc(ruleSummary(rule, dept.track, dept.ruleTrack, engine))}</span></span></div>
      ${reference.range && reference.range.years.length > 1 ? `<div class="list-row"><span class="list-row-body"><span class="list-row-title">연도별 변동폭</span></span><span class="list-row-value num">${fmt(reference.range.min)} ~ ${fmt(reference.range.max)}</span></div>` : ''}
    </div><p class="list-group-foot">컷은 최종등록자 상위 70% 지점의 국·수·탐(2) 백분위 평균입니다.</p></section>`;
    if (result.status === 'no-profile') {
      return `<div class="ip-view">${header('icon-bookmark', title, esc(dept.track))}${picker}<p class="ip-empty">국어·수학·탐구 성적을 먼저 입력해야 계산할 수 있습니다.</p>${facts}</div>`;
    }
    if (result.status === 'no-cut') {
      return `<div class="ip-view">${header('icon-bookmark', title, esc(dept.track))}${picker}<p class="ip-empty">이 모집단위는 백분위 컷이 공개되지 않아 판정을 보류합니다.</p>${facts}</div>`;
    }
    const { plan, score } = result;
    const verdict = `<section class="ip-section" aria-labelledby="ipVerdictHead"><h2 class="list-group-head" id="ipVerdictHead">판정</h2><div class="list-group">
      <div class="list-row"><span class="list-row-body"><span class="list-row-title">내 환산 백분위 − 컷</span><span class="list-row-sub">${esc(reference.primary.year)} ${esc(reference.primary.kind || '70%컷')} ${fmt(reference.primary.value)} 기준${result.spread ? ` · 오차 ±${fmt(result.spread)}` : ''}</span></span><span class="ip-row-value"><span class="ip-gap num">${signed(result.gap)}</span>${result.status === 'blocked' ? '<span class="badge badge-red">불가</span>' : badge(result.band)}</span></div>
      <div class="list-row"><span class="list-row-body"><span class="list-row-title">가중 백분위 → 환산</span><span class="list-row-sub">${esc(Object.entries(score.shares).map(([key, share]) => `${engine.SUBJECT_LABEL[key]} ${Math.round(share * 100)}%`).join(' · '))}${score.bestOfNotes.length ? ` · ${esc(score.bestOfNotes.join(', '))}` : ''}</span></span><span class="list-row-value num">${fmt(score.weighted)} → ${fmt(score.value)}</span></div>
      ${score.adjustments.map((row) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(row.label)}</span></span><span class="list-row-value num">${signed(row.delta, 2)}</span></div>`).join('')}
      ${score.blockers.map((text) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(text)}</span></span><span class="badge badge-red">불가</span></div>`).join('')}
    </div></section>`;
    const needText = plan.need > 0 ? `적정(컷 +${plan.margin})까지 ${fmt(plan.need)}점 더 필요` : '이미 적정 이상';
    const subjectRows = plan.ranked.map((row, index) => {
      const target = row.needed > 0 ? `${fmt(row.current)} → ${row.reachable ? fmt(row.targetPct) : '도달 불가'} (${row.currentGrade}등급${row.reachable && row.targetGrade !== row.currentGrade ? ` → ${row.targetGrade}등급` : ''})` : `${fmt(row.current)} 유지`;
      return `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(row.label)}${index === 0 && plan.need > 0 ? ' <span class="badge badge-accent">추천</span>' : ''}</span><span class="list-row-sub">이 영역만 올릴 때 ${target}</span></span><span class="list-row-value num">1점당 +${fmt(row.share, 2)}</span></div>`;
    }).join('');
    const englishRows = plan.english && plan.english.steps.length
      ? plan.english.steps.map((step) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">영어 ${plan.english.current}등급 → ${step.grade}등급</span></span><span class="list-row-value num">${signed(step.gain, 2)}</span></div>`).join('')
      : '';
    const planSection = `<section class="ip-section" aria-labelledby="ipPlanHead"><h2 class="list-group-head" id="ipPlanHead">필요한 상승 · ${esc(needText)}</h2><div class="list-group">
      ${plan.need > 0 ? `<div class="list-row"><span class="list-row-body"><span class="list-row-title">모든 영역을 같이 올릴 때</span></span><span class="list-row-value num">각 +${fmt(plan.uniform)}점</span></div>` : ''}
      ${subjectRows}${englishRows}
    </div><p class="list-group-foot">1점당 값은 그 영역 백분위 1점이 환산 백분위에 더하는 양입니다. 추천은 비중과 남은 여지를 함께 봅니다.</p></section>`;
    const susi = ['gyogwa', 'hakjong'].map((kind) => result[kind]).filter(Boolean);
    const susiSection = susi.length ? `<section class="ip-section" aria-labelledby="ipSusiHead"><h2 class="list-group-head" id="ipSusiHead">수시 참고 · 내신 ${fmt(profile.gpa, 2)}</h2><div class="list-group">${susi.map((row) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(row.kind === 'gyogwa' ? '학생부교과' : '학생부종합')}</span><span class="list-row-sub">${esc(row.typeName)} · ${esc(row.year)} 70%컷 ${fmt(row.cut, 2)}등급</span></span><span class="ip-row-value"><span class="list-row-value num">${signed(row.gap, 2)}</span>${badge(row.band)}</span></div>`).join('')}</div></section>` : '';
    return `<div class="ip-view">${header('icon-bookmark', title, dept.track)}${picker}${verdict}${planSection}${facts}${susiSection}</div>`;
  }

  function renderRules(state, data, engine) {
    const universityId = state.rulesUniversity || data.universities[0]?.id;
    const university = data.universities.find((item) => item.id === universityId) || data.universities[0];
    const rule = data.rules[university.id];
    const picker = `<div class="toolbar ip-toolbar" role="group" aria-label="대학 선택"><select class="field-input field-input-sm" name="rulesUniversity" aria-label="대학">${options(data.universities.map((item) => item.id), university.id, (id) => data.universities.find((item) => item.id === id).short)}</select></div>`;
    const table = (rows) => Object.entries(rows || {}).map(([grade, value]) => `${grade}등급 ${value}`).join(' · ');
    const tracks = (rule?.tracks || []).map((track, index) => {
      const weights = track.weights || {};
      const rows = [];
      if (Array.isArray(track.bestOf)) for (const group of track.bestOf) rows.push(['우수 영역 순', `${group.areas.map((area) => engine.SUBJECT_LABEL[area]).join('·')} ${group.weights.join(' · ')}`]);
      rows.push(['국어 · 수학 · 영어 · 탐구', `${weights.kor ?? '-'} · ${weights.math ?? '-'} · ${weights.eng ?? '-'} · ${weights.inq ?? '-'}${track.unit === 'points' ? '점' : '%'}`]);
      if (track.english) rows.push([`영어 ${track.english.method}`, table(track.english.table) || track.english.note || '']);
      if (track.history) rows.push([`한국사 ${track.history.method}`, table(track.history.table) || track.history.note || '']);
      if (track.inquiry) rows.push(['탐구', `${track.inquiry.count}과목 · ${track.inquiry.allowed || ''}${track.inquiry.scienceBonus ? ` · 과탐 ${Math.round(track.inquiry.scienceBonus * 100)}% 가산` : ''}${track.inquiry.socialBonus ? ` · 사탐 ${Math.round(track.inquiry.socialBonus * 100)}% 가산` : ''}${track.inquiry.note ? ` · ${track.inquiry.note}` : ''}`]);
      if (track.mathBonus) rows.push(['수학 선택', `미적분·기하 ${Math.round(track.mathBonus * 100)}% 가산`]);
      if (track.mathRequirement) rows.push(['수학 제한', track.mathRequirement]);
      if (track.note) rows.push(['비고', track.note]);
      return `<details class="disclosure"${index === 0 ? ' open' : ''}><summary class="disclosure-head"><span class="disclosure-title">${esc(track.name)}</span><span class="disclosure-hint">${esc(track.appliesTo || '')}</span></summary><div class="disclosure-body">${rows.map(([label, value]) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(label)}</span><span class="list-row-sub">${esc(value)}</span></span></div>`).join('')}</div></details>`;
    }).join('');
    const exam = data.scales?.exams?.['2026'];
    const electives = exam ? `<section class="ip-section" aria-labelledby="ipElectiveHead"><h2 class="list-group-head" id="ipElectiveHead">선택과목 원점수 컷 · ${esc(exam.label)}</h2><div class="list-group">${Object.entries(exam.subjects).filter(([key]) => key.includes('-')).map(([key, row]) => `<div class="list-row"><span class="list-row-body"><span class="list-row-title">${esc(key.replace('-', ' '))}</span><span class="list-row-sub">만점 표준점수 ${row.maxStd ?? '-'}</span></span><span class="list-row-value num">${row.grades.map((grade) => `${grade.grade}등급 ${grade.raw}`).join(' · ')}</span></div>`).join('')}</div><p class="list-group-foot">${esc(exam.notes?.[0] || '')}</p></section>` : '';
    return `<div class="ip-view">${header('icon-layers', `${university.short} 반영 방법`, rule ? `${rule.year}학년도 · ${rule.basis || ''}` : '미확인')}${picker}
      <section class="ip-section" aria-labelledby="ipRuleHead"><h2 class="list-group-head" id="ipRuleHead">계열별 반영</h2>${tracks || '<p class="ip-empty">이 대학의 반영 방법은 아직 정리되지 않았습니다.</p>'}${rule?.changes2027 ? `<p class="list-group-foot">${esc(rule.changes2027)}</p>` : ''}</section>
      ${electives}
      <section class="ip-section" aria-labelledby="ipPolicyHead"><h2 class="list-group-head" id="ipPolicyHead">2027 수능 체제</h2><div class="list-group"><div class="list-row"><span class="list-row-body"><span class="list-row-sub">${esc(data.scales?.policy2027?.summary || '')}</span></span></div></div></section>
    </div>`;
  }

  function renderSources(state, data, engine) {
    const rows = [];
    rows.push([data.sources.results.title, data.sources.results.note, data.sources.results.url]);
    rows.push([data.sources.rules.title, data.sources.rules.note, data.sources.rules.url]);
    for (const university of data.universities) if (university.resultUrl) rows.push([`${university.short} 2026 입시결과`, `모집단위 ${university.departments.length}개`, university.resultUrl]);
    for (const [id, rule] of Object.entries(data.rules)) for (const source of rule.sources || []) rows.push([`${rule.name} 2027 반영 방법`, source.title, source.url]);
    for (const source of data.scales?.exams?.['2026']?.sources || []) rows.push(['2026 수능 등급컷', source.title, source.url]);
    const bands = engine.VERDICT_BANDS.map((band) => `${band.label} ${band.min === -Infinity ? '그 아래' : `${band.min >= 0 ? '+' : ''}${band.min} 이상`}`).join(' · ');
    return `<div class="ip-view">${header('icon-info', '자료 출처', `데이터 생성일 ${esc(data.generatedAt)}`)}
      <section class="ip-section" aria-labelledby="ipMethodHead"><h2 class="list-group-head" id="ipMethodHead">판정 기준</h2><div class="list-group">
        <div class="list-row"><span class="list-row-body"><span class="list-row-title">내 환산 백분위 − 컷 (점)</span><span class="list-row-sub">${esc(bands)}</span></span></div>
        <div class="list-row"><span class="list-row-body"><span class="list-row-title">환산 방법</span><span class="list-row-sub">대학 반영비율로 가중한 백분위에 영어·한국사 가감점과 선택과목 가산을 백분위 단위로 더합니다.</span></span></div>
        <div class="list-row"><span class="list-row-body"><span class="list-row-title">오차</span><span class="list-row-sub">컷은 연도마다 흔들리므로 연도별 변동폭의 절반을 ± 오차로 보여줍니다.</span></span></div>
      </div></section>
      <section class="ip-section" aria-labelledby="ipSourceHead"><h2 class="list-group-head" id="ipSourceHead">출처 · ${rows.length}</h2><div class="list-group">${rows.map(([title, sub, url]) => `<a class="list-row list-row-nav" href="${esc(url)}" target="_blank" rel="noopener"><span class="list-row-body"><span class="list-row-title">${esc(title)}</span><span class="list-row-sub">${esc(sub)}</span></span></a>`).join('')}</div></section>
    </div>`;
  }

  const RENDERERS = { scores: renderScores, diagnose: renderDiagnose, target: renderTarget, rules: renderRules, sources: renderSources };
  window.IPSI_RENDER = { renderScores, renderDiagnose, renderTarget, renderRules, renderSources, defaultState };

  // 렌더 전에 세션을 확인한다. 토큰이 없으면 화면을 만들지 않는다.
  if (!localStorage.getItem('hvsdcm.token')) {
    location.replace(loginPath());
    return;
  }

  // ---- 바인딩 ---------------------------------------------------------------
  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const data = window.IPSI_DATA;
  const engine = window.IPSI_ENGINE;
  const state = loadState();
  let toastTimer = 0;

  function notify(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('open'), 1800);
  }
  function setNav(view) {
    document.querySelectorAll('.ip-nav').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  function render(focusSelector) {
    setNav(state.view);
    app.innerHTML = RENDERERS[state.view](state, data, engine);
    if (focusSelector) app.querySelector(focusSelector)?.focus();
  }
  function go(view) {
    state.view = view;
    state.shown = {};
    render();
    app.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  app.addEventListener('click', (event) => {
    const target = event.target.closest('[data-go], [data-mode], [data-more], [data-target]');
    if (!target) return;
    if (target.dataset.go) { go(target.dataset.go); return; }
    if (target.dataset.mode) { state.input.mode = target.dataset.mode; saveState(state); render(); return; }
    if (target.dataset.more) { state.shown[target.dataset.more] = (state.shown[target.dataset.more] || PAGE) + PAGE; render(); return; }
    if (target.dataset.target) {
      const [universityId, deptName] = target.dataset.target.split('|');
      state.target = { university: universityId, dept: deptName };
      saveState(state);
      go('target');
    }
  });
  app.addEventListener('input', (event) => {
    const field = event.target;
    if (!field.name) return;
    if (field.name in state.input) { state.input[field.name] = field.value; saveState(state); if (field.tagName === 'SELECT') render(`[name="${field.name}"]`); return; }
    if (field.name === 'query') { state.filters.query = field.value; state.shown = {}; render('#ipQuery'); const input = app.querySelector('#ipQuery'); if (input) input.setSelectionRange(input.value.length, input.value.length); saveState(state); }
  });
  app.addEventListener('change', (event) => {
    const field = event.target;
    if (!field.name) return;
    if (field.name in state.input) { render(); return; }
    if (field.name === 'line' || field.name === 'band' || field.name === 'track') { state.filters[field.name] = field.value; state.shown = {}; saveState(state); render(); return; }
    if (field.name === 'targetUniversity') { state.target = { university: field.value, dept: '' }; saveState(state); render('[name="targetDept"]'); return; }
    if (field.name === 'targetDept') { state.target.dept = field.value; saveState(state); render('[name="targetDept"]'); return; }
    if (field.name === 'rulesUniversity') { state.rulesUniversity = field.value; saveState(state); render('[name="rulesUniversity"]'); }
  });
  document.querySelectorAll('.ip-nav').forEach((button) => button.addEventListener('click', () => go(button.dataset.view)));

  if (!data || !engine) {
    app.innerHTML = '<section class="ip-error"><h1>진단 데이터를 불러오지 못했습니다.</h1><p>새로 고침한 뒤 다시 시도하세요.</p></section>';
    return;
  }
  render();
  if (data.universities.length) notify(`대학 ${data.universities.length}개 · 모집단위 ${data.universities.reduce((sum, university) => sum + university.departments.length, 0)}개`);
})();
