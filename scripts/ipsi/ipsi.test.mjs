// 입시 진단 엔진과 생성 데이터의 계약 테스트.
//   - 엔진: 등급↔백분위, 반영비율 가중, 가감점 환산, 판정 띠, 목표 학과 계획.
//   - 데이터: ipsi/assets/js/data.js가 소스 JSON에서 생성됐고 범위·출처 불변식을 지키는지.
// vm 컨텍스트가 만든 배열은 프로토타입이 달라 strict deepEqual이 실패한다 — 느슨한 assert를 쓴다.
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = process.cwd();
const load = (file, name) => {
  const context = { globalThis: null };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  return context[name];
};
const engine = load('ipsi/assets/js/engine.js', 'IPSI_ENGINE');

const RULE = {
  id: 'demo',
  tracks: [
    { name: '인문', unit: 'points', weights: { kor: 200, math: 200, eng: 0, inq: 100 }, english: { method: '감산', table: { 1: 0, 2: -5, 3: -10 }, total: 500 }, inquiry: { count: 2 } },
    { name: '자연', unit: 'points', weights: { kor: 200, math: 300, eng: 0, inq: 200 }, english: { method: '감산', table: { 1: 0, 2: -5 }, total: 700 }, inquiry: { count: 2, scienceBonus: 0.05 }, mathBonus: 0.03 },
  ],
};
const DEPT = {
  name: '경영학과', track: '인문',
  jeongsi: { 2026: { cut70: 95.0, metric: 'pct', group: '가' }, 2025: { cut70: 94.0, metric: 'pct' } },
  gyogwa: { 2026: { cut70: 1.6, typeName: '추천' } },
};
const UNIVERSITY = { id: 'demo', name: '데모대학교', short: '데모대', departments: [DEPT] };

test('grade boundaries follow the fixed relative-grading percentiles', () => {
  assert.equal(engine.gradeFromPercentile(100), 1);
  assert.equal(engine.gradeFromPercentile(96), 1);
  assert.equal(engine.gradeFromPercentile(95.9), 2);
  assert.equal(engine.gradeFromPercentile(89), 2);
  assert.equal(engine.gradeFromPercentile(77), 3);
  assert.equal(engine.gradeFromPercentile(3), 9);
  assert.equal(engine.percentileFromGrade(1), 98);
  assert.equal(engine.percentileFromGrade(5), 50);
  assert.equal(engine.gradeFromPercentile(engine.percentileFromGrade(4)), 4);
});

test('raw scores interpolate between grade-cut rows', () => {
  const rows = [{ grade: 1, raw: 88, pct: 96 }, { grade: 2, raw: 80, pct: 89 }, { grade: 3, raw: 70, pct: 77 }];
  assert.equal(engine.percentileFromRaw(84, rows), 92.5);
  assert.equal(engine.percentileFromRaw(100, rows), 100);
  assert.equal(engine.percentileFromRaw(70, rows), 77);
  assert.equal(engine.percentileFromRaw(35, rows), 38.5);
});

test('normalizeProfile converts grade input and classifies inquiry subjects', () => {
  const profile = engine.normalizeProfile({ mode: 'grade', kor: 1, math: 2, eng: 2, hist: 3, korElective: '언어와매체', mathElective: '미적분', inq1Subject: '생활과윤리', inq1: 1, inq2Subject: '물리학I', inq2: 3, gpa: '2.4' });
  assert.equal(profile.kor.pct, 98);
  assert.equal(profile.math.pct, 92.5);
  assert.equal(profile.eng.grade, 2);
  assert.deepEqual(profile.inquiries.map((row) => row.kind), ['social', 'science']);
  assert.equal(profile.gpa, 2.4);
  assert.equal(engine.profileComplete(profile), true);
  assert.equal(engine.simpleAverage(profile), 93.67);
});

test('universityScore applies weights, english deduction and elective penalties', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 96, math: 90, eng: 2, hist: 1, mathElective: '확률과통계', inq1Subject: '사회문화', inq1: 94, inq2Subject: '생활과윤리', inq2: 90 });
  const humanities = engine.universityScore(profile, RULE, '인문');
  // (96*200 + 90*200 + 92*100) / 500 = 92.8, 영어 2등급 -5/500 = -1.0
  assert.equal(humanities.weighted, 92.8);
  assert.equal(humanities.value, 91.8);
  assert.equal(humanities.adjustments.length, 1);
  const natural = engine.universityScore(profile, RULE, '자연');
  const keys = natural.adjustments.map((row) => row.key).sort();
  assert.deepEqual(keys, ['eng', 'inq-science', 'math-elective']);
  assert.ok(natural.value < natural.weighted);
});

test('evaluateJeongsi bands the gap and reports the multi-year spread', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 98, math: 97, eng: 1, inq1Subject: '사회문화', inq1: 97, inq2Subject: '생활과윤리', inq2: 95 });
  const result = engine.evaluateJeongsi(profile, UNIVERSITY, DEPT, RULE);
  assert.equal(result.status, 'ok');
  assert.equal(result.cut.value, 95);
  assert.equal(result.mine, 97.2);
  assert.equal(result.band.label, '안정');
  assert.equal(result.spread, 0.5);
  const weak = engine.normalizeProfile({ mode: 'pct', kor: 90, math: 90, eng: 3, inq1Subject: '사회문화', inq1: 90, inq2Subject: '생활과윤리', inq2: 90 });
  assert.equal(engine.evaluateJeongsi(weak, UNIVERSITY, DEPT, RULE).band.label, '위험');
});

test('score-only cuts are held back unless an estimate exists', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 98, math: 97, eng: 1, inq1Subject: '사회문화', inq1: 97, inq2Subject: '생활과윤리', inq2: 95 });
  const scoreDept = { name: '기계공학부', track: '자연', jeongsi: { 2026: { cut70: 655.2, metric: 'score', maxScore: 700 } } };
  assert.equal(engine.evaluateJeongsi(profile, UNIVERSITY, scoreDept, RULE).status, 'no-cut');
  const withEstimate = { ...scoreDept, estimate: { 2026: { pct: 96.5, source: 'jinhak' } } };
  const result = engine.evaluateJeongsi(profile, UNIVERSITY, withEstimate, RULE);
  assert.equal(result.status, 'ok');
  assert.equal(result.cut.basis, 'estimate');
});

test('analyzeTarget ranks subjects by weight and headroom and sizes the needed rise', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 93, math: 90, eng: 2, inq1Subject: '사회문화', inq1: 92, inq2Subject: '생활과윤리', inq2: 90 });
  const target = engine.analyzeTarget(profile, UNIVERSITY, DEPT, RULE);
  assert.ok(target.plan.need > 0);
  // 수학이 국어와 같은 비중이지만 현재 점수가 낮아 여지가 더 크므로 앞선다.
  assert.equal(target.plan.best.key, 'math');
  const math = target.plan.subjects.find((row) => row.key === 'math');
  assert.equal(math.share, 0.4);
  assert.equal(math.needed, engine.round(target.plan.need / 0.4, 1));
  assert.ok(target.plan.english.steps.length === 1 && target.plan.english.steps[0].gain === 1);
  assert.equal(target.gyogwa, null);
});

test('susi evaluation compares gpa with the latest cut', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 90, math: 90, eng: 2, inq1Subject: '사회문화', inq1: 90, gpa: 1.4 });
  const result = engine.evaluateSusi(profile, DEPT, 'gyogwa');
  assert.equal(result.gap, 0.2);
  assert.equal(result.band.label, '적정');
});

test('diagnose sorts departments by gap and honours track filters', () => {
  const profile = engine.normalizeProfile({ mode: 'pct', kor: 95, math: 95, eng: 1, inq1Subject: '사회문화', inq1: 95, inq2Subject: '생활과윤리', inq2: 95 });
  const data = { universities: [{ ...UNIVERSITY, departments: [DEPT, { name: '경제학과', track: '인문', jeongsi: { 2026: { cut70: 93, metric: 'pct' } } }, { name: '기계공학부', track: '자연', jeongsi: { 2026: { cut70: 93, metric: 'pct' } } }] }], rules: { demo: RULE } };
  const rows = engine.diagnose(profile, data);
  // 사탐 응시자라 과탐 가산 불이익을 받는 기계공학부의 차이가 가장 작다(오름차순 = 어려운 순).
  assert.deepEqual(rows.map((row) => row.dept.name), ['기계공학부', '경영학과', '경제학과']);
  assert.equal(engine.diagnose(profile, data, { track: '자연' }).length, 1);
});

const DATA_FILE = 'ipsi/assets/js/data.js';
test('generated data.js exists, parses, and respects value ranges', { skip: !existsSync(path.join(ROOT, DATA_FILE)) && 'data.js not generated' }, () => {
  const data = load(DATA_FILE, 'IPSI_DATA');
  assert.ok(Array.isArray(data.universities) && data.universities.length >= 20, 'at least 20 universities');
  assert.ok(data.rules && Object.keys(data.rules).length >= 20, 'rules for at least 20 universities');
  let departments = 0;
  for (const university of data.universities) {
    assert.ok(university.id && university.name && university.short, `university identity ${university.id}`);
    assert.ok(university.departments.length >= 5, `${university.id}: at least 5 departments`);
    for (const dept of university.departments) {
      departments += 1;
      assert.ok(['인문', '자연', '의약', '예체능', '자유전공'].includes(dept.track), `${university.id} ${dept.name}: track ${dept.track}`);
      for (const [year, row] of Object.entries(dept.jeongsi || {})) {
        assert.match(year, /^20\d\d$/u);
        if (row.metric === 'pct') assert.ok(row.cut70 > 20 && row.cut70 <= 100, `${university.id} ${dept.name} ${year}: pct cut ${row.cut70}`);
        if (row.metric === 'score') assert.ok(row.cut70 > 0 && row.maxScore >= row.cut70, `${university.id} ${dept.name} ${year}: score cut`);
        assert.ok(typeof row.url === 'string' && /^https?:/u.test(row.url), `${university.id} ${dept.name} ${year}: jeongsi url`);
      }
      for (const kind of ['gyogwa', 'hakjong']) {
        for (const [year, row] of Object.entries(dept[kind] || {})) {
          assert.ok(row.cut70 >= 1 && row.cut70 <= 9, `${university.id} ${dept.name} ${kind} ${year}: grade cut ${row.cut70}`);
        }
      }
    }
  }
  assert.ok(departments >= 300, `at least 300 departments (found ${departments})`);
  for (const [id, rule] of Object.entries(data.rules)) {
    assert.ok(Array.isArray(rule.tracks) && rule.tracks.length >= 1, `${id}: tracks`);
    for (const track of rule.tracks) {
      const weights = track.weights || {};
      const bestOf = (track.bestOf || []).flatMap((group) => group.weights || []).reduce((sum, weight) => sum + weight, 0);
      assert.ok((weights.kor || 0) + (weights.math || 0) + (weights.inq || 0) + bestOf > 0, `${id} ${track.name}: weights`);
    }
  }
  assert.ok(data.scales?.exams?.['2026']?.subjects, 'scales for the 2026 exam');
});
