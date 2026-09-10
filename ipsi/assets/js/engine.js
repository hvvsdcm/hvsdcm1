// 입시 진단 계산 엔진 (/ipsi/). 화면(app.js)과 노드 테스트(scripts/ipsi/ipsi.test.mjs)가
// 같은 파일을 쓴다 — DOM을 만지지 않고 순수 함수만 둔다.
//
// 계약
//   - 성적은 **백분위**로 통일한다. 등급·원점수 입력은 여기서 백분위로 바꾼 뒤 같은 길을 간다.
//     상대평가 등급 경계(1등급 상위 4% …)는 제도가 고정한 값이라 연도와 무관하다.
//   - 대학별 판정의 기준값은 어디가 '최종등록자 70% 컷'이다. 대학은 그 값을 국·수·탐(2) 백분위
//     평균(metric 'pct')으로 내거나 환산점수(metric 'score')로 낸다. 환산점수만 있는 모집단위는
//     사설 기관의 백분위 추정(estimate)이 있을 때만 판정하고, 없으면 판정을 보류한다 —
//     표준점수 기반 환산을 백분위로 되돌리는 것은 오차가 커서 숫자를 지어내는 셈이 된다.
//   - 대학 반영 방법(rules)은 (1) 영역별 반영비율로 가중 백분위를 만들고 (2) 영어·한국사
//     가감점, 탐구·수학 선택과목 가산을 백분위 평균 단위로 환산해 더한다. 영어가 비율로
//     반영되는 대학은 등급 환산표의 비율만큼 가중 평균 안에 넣는다.
//   - 판정 띠(안정/적정/소신/상향/위험)는 컷과의 차이(백분위 점)로 정한다. 컷 자체의 연도별
//     변동폭을 함께 돌려주므로 화면은 "오차범위"를 숫자로 보여줄 수 있다.
(() => {
  'use strict';

  // 상대평가 등급의 백분위 하한. 1등급 = 상위 4% (백분위 96 이상) … 8등급 = 상위 96%.
  const GRADE_FLOORS = Object.freeze([96, 89, 77, 60, 40, 23, 11, 4, 0]);
  // 등급만 입력했을 때 쓰는 대표 백분위 — 각 등급 구간의 중앙값.
  const GRADE_MIDPOINTS = Object.freeze([98, 92.5, 83, 68.5, 50, 31.5, 17, 7.5, 2]);
  // 영어·한국사(절대평가) 등급의 원점수 하한. 90 이상 1등급 … 한국사는 40점 만점 기준 별도.
  const ENGLISH_RAW_FLOORS = Object.freeze([90, 80, 70, 60, 50, 40, 30, 20, 0]);
  const HISTORY_RAW_FLOORS = Object.freeze([40, 35, 30, 25, 20, 15, 10, 5, 0]);

  const SOCIAL_SUBJECTS = Object.freeze(['생활과윤리', '윤리와사상', '한국지리', '세계지리', '동아시아사', '세계사', '경제', '정치와법', '사회문화']);
  const SCIENCE_SUBJECTS = Object.freeze(['물리학I', '화학I', '생명과학I', '지구과학I', '물리학II', '화학II', '생명과학II', '지구과학II']);
  const KOR_ELECTIVES = Object.freeze(['화법과작문', '언어와매체']);
  const MATH_ELECTIVES = Object.freeze(['확률과통계', '미적분', '기하']);

  const SUBJECT_LABEL = Object.freeze({
    kor: '국어', math: '수학', eng: '영어', inq: '탐구', inq1: '탐구1', inq2: '탐구2', hist: '한국사',
  });

  // 판정 띠. 값은 "내 환산 백분위 − 컷" (점). 위쪽 경계는 포함.
  const VERDICT_BANDS = Object.freeze([
    { key: 'safe', label: '안정', min: 2 },
    { key: 'fit', label: '적정', min: 0.7 },
    { key: 'reach', label: '소신', min: -0.7 },
    { key: 'stretch', label: '상향', min: -2 },
    { key: 'risky', label: '위험', min: -Infinity },
  ]);
  // 수시(내신 등급) 판정 띠. 값은 "컷 등급 − 내 등급" (등급, 클수록 유리).
  const SUSI_BANDS = Object.freeze([
    { key: 'safe', label: '안정', min: 0.3 },
    { key: 'fit', label: '적정', min: 0.1 },
    { key: 'reach', label: '소신', min: -0.1 },
    { key: 'stretch', label: '상향', min: -0.3 },
    { key: 'risky', label: '위험', min: -Infinity },
  ]);
  // '적정' 판정을 목표로 삼을 때의 여유 (점). 목표 학과 계산이 이 값을 더한다.
  const TARGET_MARGIN = 0.7;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const round = (value, digits = 1) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  function gradeFromPercentile(pct) {
    if (!isNumber(pct)) return null;
    const index = GRADE_FLOORS.findIndex((floor) => pct >= floor);
    return index === -1 ? 9 : index + 1;
  }
  function percentileFromGrade(grade) {
    const index = clamp(Math.round(Number(grade)) - 1, 0, 8);
    return GRADE_MIDPOINTS[index];
  }
  // 등급 n의 백분위 하한 — "몇 등급까지 올려야 하나"를 말할 때 그 등급의 문턱이다.
  function percentileFloorOfGrade(grade) {
    return GRADE_FLOORS[clamp(Math.round(Number(grade)) - 1, 0, 8)];
  }
  function gradeFromRaw(raw, floors) {
    if (!isNumber(raw)) return null;
    const index = floors.findIndex((floor) => raw >= floor);
    return index === -1 ? 9 : index + 1;
  }

  // 원점수 → 백분위. 등급컷 표(등급별 원점수·백분위 점)를 선형 보간한다.
  // 표의 점 사이는 실제 분포와 다를 수 있으므로 호출자는 '추정'이라 표시한다.
  function percentileFromRaw(raw, gradeRows) {
    if (!isNumber(raw) || !Array.isArray(gradeRows) || gradeRows.length === 0) return null;
    const points = gradeRows
      .filter((row) => isNumber(row.raw) && isNumber(row.pct))
      .map((row) => ({ raw: row.raw, pct: row.pct }))
      .sort((left, right) => right.raw - left.raw);
    if (points.length === 0) return null;
    const max = points[0];
    if (raw >= max.raw) {
      // 1등급 컷 위쪽: 만점(백분위 100)까지 선형.
      const span = 100 - max.raw;
      if (span <= 0) return 100;
      return round(max.pct + (100 - max.pct) * ((raw - max.raw) / span), 1);
    }
    for (let index = 0; index < points.length - 1; index += 1) {
      const upper = points[index];
      const lower = points[index + 1];
      if (raw >= lower.raw) {
        const ratio = (raw - lower.raw) / (upper.raw - lower.raw || 1);
        return round(lower.pct + (upper.pct - lower.pct) * ratio, 1);
      }
    }
    const last = points[points.length - 1];
    return round(clamp(last.pct * (raw / (last.raw || 1)), 0, last.pct), 1);
  }

  const inquiryKind = (subject) => {
    if (SCIENCE_SUBJECTS.includes(subject)) return 'science';
    if (SOCIAL_SUBJECTS.includes(subject)) return 'social';
    return null;
  };

  // 화면 입력(문자열 섞임)을 정규화한 프로필로 만든다. 비어 있는 영역은 null이다.
  // scales는 원점수 입력을 백분위로 바꿀 때만 필요하다 (scales.exams[year].subjects[key].grades).
  function normalizeProfile(input, scales) {
    const source = input || {};
    const mode = ['pct', 'grade', 'raw'].includes(source.mode) ? source.mode : 'pct';
    const year = String(source.year || (scales && Object.keys(scales.exams || {}).sort().at(-1)) || '');
    const table = scales?.exams?.[year]?.subjects || {};
    const toNumber = (value) => {
      if (value === '' || value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const relative = (value, subjectKey) => {
      const number = toNumber(value);
      if (number === null) return null;
      if (mode === 'grade') return percentileFromGrade(clamp(number, 1, 9));
      if (mode === 'raw') {
        const rows = table[subjectKey]?.grades;
        const pct = percentileFromRaw(clamp(number, 0, 100), rows);
        return pct === null ? null : pct;
      }
      return clamp(number, 0, 100);
    };
    const absolute = (value, floors) => {
      const number = toNumber(value);
      if (number === null) return null;
      if (mode === 'raw') return gradeFromRaw(number, floors);
      return clamp(Math.round(number), 1, 9);
    };
    const korElective = KOR_ELECTIVES.includes(source.korElective) ? source.korElective : KOR_ELECTIVES[0];
    const mathElective = MATH_ELECTIVES.includes(source.mathElective) ? source.mathElective : MATH_ELECTIVES[0];
    const inquiries = [];
    for (const slot of ['inq1', 'inq2']) {
      const subject = source[`${slot}Subject`];
      const kind = inquiryKind(subject);
      const pct = kind ? relative(source[slot], subject) : null;
      if (kind && pct !== null) inquiries.push({ slot, subject, kind, pct });
    }
    const gpa = toNumber(source.gpa);
    return {
      mode,
      year,
      kor: { elective: korElective, pct: relative(source.kor, `국어-${korElective}`) },
      math: { elective: mathElective, pct: relative(source.math, `수학-${mathElective}`) },
      eng: { grade: absolute(source.eng, ENGLISH_RAW_FLOORS) },
      hist: { grade: absolute(source.hist, HISTORY_RAW_FLOORS) },
      inquiries,
      gpa: gpa === null ? null : clamp(gpa, 1, 9),
    };
  }

  const profileComplete = (profile) => Boolean(profile
    && isNumber(profile.kor?.pct) && isNumber(profile.math?.pct) && profile.inquiries?.length > 0);

  // 탐구 반영값: count=2면 두 과목 평균(한 과목뿐이면 그 과목), count=1이면 상위 1과목.
  function inquiryPercentile(profile, count = 2) {
    const sorted = [...(profile.inquiries || [])].sort((left, right) => right.pct - left.pct);
    if (sorted.length === 0) return null;
    const used = sorted.slice(0, Math.max(1, count));
    return used.reduce((sum, row) => sum + row.pct, 0) / used.length;
  }

  // 어디가 백분위 평균(국·수·탐(2) 평균)과 같은 단순 지표. 대학 반영비율을 적용하기 전의 기준값.
  function simpleAverage(profile) {
    if (!profileComplete(profile)) return null;
    return round((profile.kor.pct + profile.math.pct + inquiryPercentile(profile, 2)) / 3, 2);
  }

  // rules[uni].tracks 중 모집단위 계열에 맞는 트랙. 'appliesTo'/name에 계열 이름이 들어 있으면 그것,
  // 없으면 첫 트랙. 의약·자유전공은 자연 → 인문 순으로 대체한다.
  function pickTrack(rule, track, ruleTrack) {
    const tracks = Array.isArray(rule?.tracks) ? rule.tracks : [];
    if (tracks.length === 0) return null;
    const wanted = [];
    if (ruleTrack) wanted.push(ruleTrack);
    wanted.push(track);
    if (track === '상경') wanted.push('인문');
    if (track === '의약') wanted.push('자연');
    if (track === '자유전공') wanted.push('인문', '자연');
    if (track === '예체능') wanted.push('인문');
    for (const name of wanted) {
      const exact = tracks.find((candidate) => candidate.name === name);
      if (exact) return exact;
      const loose = tracks.find((candidate) => String(candidate.name || '').includes(name) || String(candidate.appliesTo || '').includes(name));
      if (loose) return loose;
    }
    return tracks[0];
  }

  const englishTable = (english) => {
    const table = english?.table || {};
    const rows = {};
    for (let grade = 1; grade <= 9; grade += 1) {
      const value = table[String(grade)] ?? table[grade];
      rows[grade] = isNumber(Number(value)) && value !== null && value !== undefined ? Number(value) : null;
    }
    return rows;
  };

  // 가감점(점)을 백분위 평균 단위로 바꾼다. total = 대학 환산 총점(가감점이 붙는 기준 총점).
  const pointsToPercentile = (points, total) => (isNumber(points) && isNumber(total) && total > 0 ? (points / total) * 100 : 0);

  // 대학 반영 방법을 프로필에 적용한 값. 결과 단위는 백분위 평균(0~100)이다.
  //   weighted: 국·수·탐(·영어 비율반영) 가중 평균
  //   adjustments: 영어/한국사 가감, 선택과목 가산·불이익을 백분위 단위로 바꾼 항목들
  //   value: weighted + Σ adjustments
  //   shares: 영역별 가중치 비율(합 1) — 목표 학과의 "1점 올리면 얼마" 계산이 쓴다
  function universityScore(profile, rule, deptTrack, ruleTrack) {
    if (!profileComplete(profile)) return null;
    const track = pickTrack(rule, deptTrack, ruleTrack);
    const weights = { ...(track?.weights || {}) };
    const inquiryCount = Number(track?.inquiry?.count) || 2;
    const inqPct = inquiryPercentile(profile, inquiryCount);
    // '우수한 영역 순' 반영: 그룹 안의 영역을 내 점수 순으로 줄 세워 큰 가중치부터 준다.
    const bestOfNotes = [];
    for (const group of Array.isArray(track?.bestOf) ? track.bestOf : []) {
      const current = { kor: profile.kor.pct, math: profile.math.pct, inq: inqPct };
      const ordered = (group.areas || []).filter((area) => isNumber(current[area])).sort((a, b) => current[b] - current[a]);
      const sortedWeights = [...(group.weights || [])].sort((a, b) => b - a);
      ordered.forEach((area, index) => { weights[area] = (Number(weights[area]) || 0) + (Number(sortedWeights[index]) || 0); });
      bestOfNotes.push(`${ordered.map((area) => SUBJECT_LABEL[area]).join(' > ')} 순 ${sortedWeights.join('·')}`);
    }
    const wKor = Number(weights.kor) || 0;
    const wMath = Number(weights.math) || 0;
    const wInq = Number(weights.inq) || 0;
    const wEng = Number(weights.eng) || 0;
    const unit = track?.unit === 'points' ? 'points' : 'percent';
    const englishMethod = track?.english?.method || (wEng > 0 ? '비율반영' : '가산');
    const engRows = englishTable(track?.english);
    const englishByRatio = wEng > 0 && englishMethod === '비율반영';
    const engGrade = profile.eng.grade;

    // 반영비율이 하나도 없으면(규칙 미확인) 단순 평균으로 대체하고 그렇게 표시한다.
    const hasWeights = wKor + wMath + wInq > 0;
    const parts = hasWeights
      ? [
        { key: 'kor', weight: wKor, pct: profile.kor.pct },
        { key: 'math', weight: wMath, pct: profile.math.pct },
        { key: 'inq', weight: wInq, pct: inqPct },
      ]
      : [
        { key: 'kor', weight: 1, pct: profile.kor.pct },
        { key: 'math', weight: 1, pct: profile.math.pct },
        { key: 'inq', weight: 1, pct: inqPct },
      ];
    if (englishByRatio && isNumber(engGrade)) {
      const top = engRows[1];
      const mine = engRows[engGrade];
      const ratio = isNumber(top) && top > 0 && isNumber(mine) ? clamp(mine / top, 0, 1) : (engGrade === 1 ? 1 : null);
      if (ratio !== null) parts.push({ key: 'eng', weight: wEng, pct: ratio * 100 });
    }
    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    const shares = {};
    for (const part of parts) shares[part.key] = part.weight / totalWeight;
    const weighted = parts.reduce((sum, part) => sum + part.weight * part.pct, 0) / totalWeight;

    // 가감점의 기준 총점: points 단위면 반영 영역 배점 합(영어 비율반영이면 포함), percent 단위면
    // 규칙이 준 total, 없으면 1000점 만점으로 본다 (대부분의 대학이 1000점 환산이다).
    const baseTotal = unit === 'points'
      ? parts.reduce((sum, part) => sum + part.weight, 0)
      : (Number(track?.total) || 1000);

    const adjustments = [];
    if (!englishByRatio && isNumber(engGrade)) {
      const top = engRows[1];
      const mine = engRows[engGrade];
      if (isNumber(top) && isNumber(mine) && mine !== top) {
        const delta = pointsToPercentile(mine - top, track?.english?.total || baseTotal);
        adjustments.push({ key: 'eng', label: `영어 ${engGrade}등급 ${englishMethod === '감산' ? '감점' : '가산 차이'}`, delta: round(delta, 2) });
      }
    }
    const histGrade = profile.hist.grade;
    const histRows = englishTable(track?.history);
    if (isNumber(histGrade) && isNumber(histRows[1]) && isNumber(histRows[histGrade]) && histRows[histGrade] !== histRows[1]) {
      const delta = pointsToPercentile(histRows[histGrade] - histRows[1], track?.history?.total || baseTotal);
      adjustments.push({ key: 'hist', label: `한국사 ${histGrade}등급 가감`, delta: round(delta, 2) });
    }

    // 탐구 선택과목: 자연계 모집단위의 과탐 가산은 등록자 대부분이 받았다고 보고, 사탐 응시자에게
    // 그만큼의 불이익으로 적는다. 인문계 사탐 가산도 같은 논리로 대칭 처리한다.
    const inquiry = track?.inquiry || {};
    const scienceBonus = Number(inquiry.scienceBonus) || 0;
    const socialBonus = Number(inquiry.socialBonus) || 0;
    const kinds = new Set((profile.inquiries || []).map((row) => row.kind));
    const inqShare = shares.inq || 0;
    const naturalDept = ['자연', '의약'].includes(deptTrack);
    const blockers = [];
    if (scienceBonus > 0 && isNumber(inqPct)) {
      if (kinds.has('social') && !kinds.has('science')) {
        adjustments.push({ key: 'inq-science', label: `과탐 가산 ${round(scienceBonus * 100)}% 미적용(사탐 응시)`, delta: round(-scienceBonus * inqShare * inqPct, 2) });
      } else if (kinds.has('social') && kinds.has('science')) {
        adjustments.push({ key: 'inq-science', label: `과탐 가산 ${round(scienceBonus * 100)}% 한 과목만`, delta: round(-scienceBonus * inqShare * inqPct * 0.5, 2) });
      }
    }
    if (socialBonus > 0 && isNumber(inqPct) && !kinds.has('social')) {
      adjustments.push({ key: 'inq-social', label: `사탐 가산 ${round(socialBonus * 100)}% 미적용(과탐 응시)`, delta: round(-socialBonus * inqShare * inqPct, 2) });
    }
    if (inquiry.allowed === '과탐만' && naturalDept && !kinds.has('science')) {
      blockers.push('과탐 필수 모집단위 — 사탐만으로는 지원 불가');
    }
    const mathBonus = Number(track?.mathBonus) || 0;
    const mathElective = profile.math.elective;
    const mathAdvanced = mathElective === '미적분' || mathElective === '기하';
    if (mathBonus > 0 && !mathAdvanced) {
      adjustments.push({ key: 'math-elective', label: `미적분·기하 가산 ${round(mathBonus * 100)}% 미적용(확률과통계)`, delta: round(-mathBonus * (shares.math || 0) * profile.math.pct, 2) });
    }
    if (String(track?.mathRequirement || '').includes('필수') && !mathAdvanced) {
      blockers.push('미적분·기하 필수 모집단위 — 확률과통계로는 지원 불가');
    }

    const totalAdjustment = adjustments.reduce((sum, row) => sum + row.delta, 0);
    return {
      track: track?.name || null,
      trackFound: Boolean(track),
      hasWeights,
      shares,
      weighted: round(weighted, 2),
      adjustments,
      blockers,
      value: round(weighted + totalAdjustment, 2),
      bestOfNotes,
      inquiryCount,
      englishByRatio,
      engRows,
      baseTotal,
    };
  }

  // 모집단위의 정시 기준값. 최신 연도의 백분위 컷을 우선하고, 환산점수만 있으면 사설 추정을 쓴다.
  // 연도별 값 목록(백분위 단위만)을 함께 돌려주어 변동폭을 계산한다.
  function jeongsiReference(dept) {
    const years = Object.keys(dept?.jeongsi || {}).sort().reverse();
    const history = [];
    for (const year of years) {
      const row = dept.jeongsi[year];
      if (!row || (row.metric || 'pct') !== 'pct') continue;
      // 70% 컷이 없으면 평균, 그것도 없으면 최저를 쓰되 어떤 값인지 kind로 남긴다.
      const candidate = isNumber(row.cut70) ? { value: row.cut70, kind: '70%컷' }
        : isNumber(row.avg) ? { value: row.avg, kind: '평균' }
          : isNumber(row.min) ? { value: row.min, kind: '최저' } : null;
      if (candidate) history.push({ year, value: candidate.value, kind: candidate.kind, source: row.source, url: row.url, group: row.group || null });
    }
    const estimates = Object.keys(dept?.estimate || {}).sort().reverse()
      .map((year) => ({ year, ...dept.estimate[year] }))
      .filter((row) => isNumber(row.pct));
    let primary = null;
    if (history.length > 0) primary = { year: history[0].year, value: history[0].value, kind: history[0].kind, basis: 'adiga', source: history[0].source, url: history[0].url };
    else if (estimates.length > 0) primary = { year: estimates[0].year, value: estimates[0].pct, basis: 'estimate', source: estimates[0].source, url: estimates[0].url };
    const scoreRows = years.map((year) => ({ year, ...dept.jeongsi[year] })).filter((row) => row.metric === 'score' && isNumber(row.cut70));
    const values = history.map((row) => row.value);
    const range = values.length > 0 ? { min: Math.min(...values), max: Math.max(...values), years: history.map((row) => row.year) } : null;
    return { primary, history, estimates, scoreRows, range };
  }

  function bandOf(gap, bands) {
    if (!isNumber(gap)) return null;
    return bands.find((band) => gap >= band.min) || bands[bands.length - 1];
  }

  // 한 모집단위에 대한 정시 판정.
  function evaluateJeongsi(profile, university, dept, rule) {
    const reference = jeongsiReference(dept);
    const score = universityScore(profile, rule, dept.track, dept.ruleTrack);
    if (!score) return { status: 'no-profile', reference, score: null };
    if (!reference.primary) return { status: 'no-cut', reference, score };
    const gap = round(score.value - reference.primary.value, 2);
    const band = bandOf(gap, VERDICT_BANDS);
    // 연도별 변동폭 — 컷이 흔들린 만큼 판정도 흔들린다. 반값을 ± 오차로 보여준다.
    const spread = reference.range ? round((reference.range.max - reference.range.min) / 2, 1) : null;
    return {
      status: score.blockers.length > 0 ? 'blocked' : 'ok',
      universityId: university.id,
      universityName: university.short || university.name,
      dept: dept.name,
      track: dept.track,
      group: dept.jeongsi?.[reference.primary.year]?.group || null,
      cut: reference.primary,
      mine: score.value,
      gap,
      band,
      spread,
      reference,
      score,
    };
  }

  // 수시(교과·학종) 판정. 내신 등급이 없으면 null.
  function evaluateSusi(profile, dept, kind) {
    if (!isNumber(profile?.gpa)) return null;
    const rows = dept?.[kind] || {};
    const years = Object.keys(rows).sort().reverse().filter((year) => isNumber(rows[year]?.cut70));
    if (years.length === 0) return null;
    const latest = { year: years[0], ...rows[years[0]] };
    const gap = round(latest.cut70 - profile.gpa, 2);
    const values = years.map((year) => rows[year].cut70);
    return {
      kind,
      typeName: latest.typeName || '',
      cut: latest.cut70,
      year: latest.year,
      gap,
      band: bandOf(gap, SUSI_BANDS),
      range: { min: Math.min(...values), max: Math.max(...values), years },
      source: latest.source,
      url: latest.url,
    };
  }

  // 전체 진단: 모든 대학·모집단위를 판정해 정렬한다. filters: { track, universities:Set, group }
  function diagnose(profile, data, filters = {}) {
    const rows = [];
    for (const university of data.universities || []) {
      if (filters.universities && filters.universities.size > 0 && !filters.universities.has(university.id)) continue;
      const rule = data.rules?.[university.id];
      for (const dept of university.departments || []) {
        if (filters.track && filters.track !== '전체' && dept.track !== filters.track) continue;
        const result = evaluateJeongsi(profile, university, dept, rule);
        if (filters.group && filters.group !== '전체' && result.group && result.group !== filters.group) continue;
        rows.push({
          universityId: university.id,
          universityName: university.short || university.name,
          universityOrder: university.order ?? 0,
          dept,
          jeongsi: result,
          gyogwa: evaluateSusi(profile, dept, 'gyogwa'),
          hakjong: evaluateSusi(profile, dept, 'hakjong'),
        });
      }
    }
    rows.sort((left, right) => {
      const l = left.jeongsi.gap; const r = right.jeongsi.gap;
      if (isNumber(l) && isNumber(r)) return l - r;
      if (isNumber(l)) return -1;
      if (isNumber(r)) return 1;
      return left.universityOrder - right.universityOrder;
    });
    return rows;
  }

  // 목표 학과: 필요한 상승폭과 영역별 투자 효율.
  function analyzeTarget(profile, university, dept, rule) {
    const result = evaluateJeongsi(profile, university, dept, rule);
    if (result.status === 'no-profile' || result.status === 'no-cut') return { ...result, plan: null };
    const { score } = result;
    const need = round(Math.max(0, result.cut.value + TARGET_MARGIN - score.value), 2);
    const subjects = [];
    const inquiryRows = [...profile.inquiries].sort((left, right) => right.pct - left.pct).slice(0, score.inquiryCount);
    const addSubject = (key, label, current, share) => {
      if (!isNumber(current) || share <= 0) return;
      const perPoint = round(share, 3);
      const headroom = 100 - current;
      const needed = need > 0 ? round(need / share, 1) : 0;
      const reachable = needed <= headroom;
      const targetPct = reachable ? round(current + needed, 1) : 100;
      const currentGrade = gradeFromPercentile(current);
      const targetGrade = gradeFromPercentile(targetPct);
      // 효율 = 영역 비중 × 남은 여지. 이미 99인 영역은 올릴 곳이 없다.
      const efficiency = share * clamp(headroom / 10, 0, 1);
      subjects.push({ key, label, current: round(current, 1), share: perPoint, needed, reachable, targetPct, currentGrade, targetGrade, gradesUp: Math.max(0, currentGrade - targetGrade), efficiency: round(efficiency, 3) });
    };
    addSubject('kor', `국어(${profile.kor.elective})`, profile.kor.pct, score.shares.kor || 0);
    addSubject('math', `수학(${profile.math.elective})`, profile.math.pct, score.shares.math || 0);
    const inqShareEach = (score.shares.inq || 0) / Math.max(1, inquiryRows.length);
    for (const row of inquiryRows) addSubject(row.slot, `탐구 ${row.subject}`, row.pct, inqShareEach);
    if (score.englishByRatio && isNumber(profile.eng.grade)) {
      const ratio = isNumber(score.engRows[profile.eng.grade]) && isNumber(score.engRows[1]) ? score.engRows[profile.eng.grade] / score.engRows[1] : 1;
      addSubject('eng', '영어(비율 반영)', ratio * 100, score.shares.eng || 0);
    }
    // 영어 가감점 대학: 등급을 하나 올릴 때의 이득(점)을 등급별로 계산한다.
    let english = null;
    if (!score.englishByRatio && isNumber(profile.eng.grade)) {
      const rows = score.engRows;
      const total = pickTrack(rule, dept.track, dept.ruleTrack)?.english?.total || score.baseTotal;
      const steps = [];
      for (let grade = profile.eng.grade - 1; grade >= 1; grade -= 1) {
        if (!isNumber(rows[grade]) || !isNumber(rows[profile.eng.grade])) break;
        steps.push({ grade, gain: round(pointsToPercentile(rows[grade] - rows[profile.eng.grade], total), 2) });
      }
      english = { current: profile.eng.grade, steps, enough: steps.find((step) => step.gain >= need) || null };
    }
    const ranked = [...subjects].sort((left, right) => right.efficiency - left.efficiency);
    // 모든 영역을 같은 폭으로 올릴 때 필요한 상승폭(가중 평균이므로 = need).
    const uniform = need > 0 ? round(need / Object.values(score.shares).reduce((sum, share) => sum + share, 0), 1) : 0;
    return {
      ...result,
      plan: {
        need,
        margin: TARGET_MARGIN,
        subjects,
        ranked,
        best: ranked[0] || null,
        uniform,
        english,
        adjustments: score.adjustments,
        blockers: score.blockers,
      },
      gyogwa: evaluateSusi(profile, dept, 'gyogwa'),
      hakjong: evaluateSusi(profile, dept, 'hakjong'),
    };
  }

  // 선택과목 유불리 요약(scales.exams[year]) — 같은 원점수의 만점 표준점수 차이 등을 화면이 쓴다.
  function electiveSummary(scales, year) {
    const exam = scales?.exams?.[year];
    if (!exam) return null;
    const pick = (key) => exam.subjects?.[key] || null;
    const summarize = (keys) => keys.map((key) => ({ key, label: key.split('-').pop(), maxStd: pick(key)?.maxStd ?? null, share: exam.electiveShare?.[key.split('-')[0]]?.[key.split('-').pop()] ?? null }));
    return {
      year,
      kor: summarize(KOR_ELECTIVES.map((name) => `국어-${name}`)),
      math: summarize(MATH_ELECTIVES.map((name) => `수학-${name}`)),
    };
  }

  const api = Object.freeze({
    GRADE_FLOORS, GRADE_MIDPOINTS, SOCIAL_SUBJECTS, SCIENCE_SUBJECTS, KOR_ELECTIVES, MATH_ELECTIVES, SUBJECT_LABEL,
    VERDICT_BANDS, SUSI_BANDS, TARGET_MARGIN,
    gradeFromPercentile, percentileFromGrade, percentileFloorOfGrade, percentileFromRaw, inquiryKind,
    normalizeProfile, profileComplete, inquiryPercentile, simpleAverage, pickTrack, universityScore,
    jeongsiReference, evaluateJeongsi, evaluateSusi, diagnose, analyzeTarget, electiveSummary, round,
  });
  globalThis.IPSI_ENGINE = api;
})();
