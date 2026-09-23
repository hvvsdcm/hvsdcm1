import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

await import('../assets/js/study-utils.js');

const {
  SORT_MODES,
  createToast,
  matchesMeaningAnswer,
  matchesStudySearch,
  shuffle,
  sortStudyItems,
} = globalThis.HvsStudyUtils;
const items = [
  { id: 'unseen', order: 1, wrongRate: null, wrongCount: 0, recentAt: null },
  { id: 'low', order: 2, wrongRate: 20, wrongCount: 4, recentAt: 100 },
  { id: 'high-old', order: 3, wrongRate: 80, wrongCount: 2, recentAt: 200 },
  { id: 'high-new', order: 4, wrongRate: 80, wrongCount: 5, recentAt: 300 },
];
const metrics = {
  wrongRate: (item) => item.wrongRate,
  wrongCount: (item) => item.wrongCount,
  recentAt: (item) => item.recentAt,
  compareDefault: (left, right) => left.order - right.order,
};

test('wrong-rate sorting keeps unseen questions after measured records', () => {
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_HIGH, metrics).map((item) => item.id),
    ['high-new', 'high-old', 'low', 'unseen'],
  );
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_LOW, metrics).map((item) => item.id),
    ['low', 'high-new', 'high-old', 'unseen'],
  );
});

test('all 100-percent wrong rates put the highest cumulative mistake count first', () => {
  const allWrong = [
    { id: 'once', order: 1, wrongRate: 100, wrongCount: 1 },
    { id: 'seven-times', order: 2, wrongRate: 100, wrongCount: 7 },
    { id: 'three-times', order: 3, wrongRate: 100, wrongCount: 3 },
  ];

  for (const mode of [SORT_MODES.WRONG_HIGH, SORT_MODES.WRONG_LOW]) {
    assert.deepEqual(
      sortStudyItems(allWrong, mode, metrics).map((item) => item.id),
      ['seven-times', 'three-times', 'once'],
    );
  }
});

test('recent sorting is newest first with a deterministic fallback', () => {
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.RECENT, metrics).map((item) => item.id),
    ['high-new', 'high-old', 'low', 'unseen'],
  );
  assert.deepEqual(
    sortStudyItems([...items].reverse(), SORT_MODES.SEQUENTIAL, metrics).map((item) => item.id),
    ['unseen', 'low', 'high-old', 'high-new'],
  );
});

test('study search ignores English case and whitespace', () => {
  const fields = ['make up', '구성하다, 지어내다'];

  assert.equal(matchesStudySearch(' M A K E U P ', fields), true);
  assert.equal(matchesStudySearch('MAKEup', fields), true);
  assert.equal(matchesStudySearch('break down', fields), false);
});

test('study search ignores Korean whitespace and shows all for a blank query', () => {
  const fields = ['make up', '구성하다, 지어내다'];

  assert.equal(matchesStudySearch('구 성 하 다', fields), true);
  assert.equal(matchesStudySearch('지어 내다', fields), true);
  assert.equal(matchesStudySearch('   ', fields), true);
});

test('the shared shuffle is Fisher–Yates: a uniform draw that never mutates its input', () => {
  const source = Array.from({ length: 90 }, (_, index) => index);
  const original = Math.random;
  try {
    // 상수 난수에서 Fisher–Yates의 결과는 하나로 정해진다. 비교 함수 셔플
    // (sort(() => Math.random() - .5))은 같은 입력에서 다른 순서를 낸다 — 분포가
    // 치우쳐 90문항 중 특정 문항이 거의 뽑히지 않던 원래 버그를 여기서 막는다.
    Math.random = () => 0;
    assert.deepEqual(shuffle([0, 1, 2, 3]), [1, 2, 3, 0]);
  } finally {
    Math.random = original;
  }

  const firstSlots = new Set();
  for (let run = 0; run < 2000; run += 1) {
    const drawn = shuffle(source).slice(0, 20);
    assert.equal(new Set(drawn).size, 20, '한 회차에서 같은 문항이 두 번 나오면 안 된다');
    firstSlots.add(drawn[0]);
  }
  assert.equal(firstSlots.size, 90, '90문항 전부가 첫 자리에 올 수 있어야 한다');
  assert.deepEqual(source, Array.from({ length: 90 }, (_, index) => index), 'shuffle은 입력을 건드리지 않는다');
});

test('a toast shows the latest message and hides after its own delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = { textContent: '', classes: new Set() };
  element.classList = {
    add: (name) => element.classes.add(name),
    remove: (name) => element.classes.delete(name),
    contains: (name) => element.classes.has(name),
  };
  const showToast = createToast(element, 1900);

  showToast('첫 번째 메시지');
  assert.equal(element.textContent, '첫 번째 메시지');
  assert.equal(element.classList.contains('open'), true);

  // 두 번째 메시지가 먼저 온 타이머에 지워지면 안 된다 — 타이머는 만든 자리마다 따로다.
  t.mock.timers.tick(1000);
  showToast('두 번째 메시지');
  t.mock.timers.tick(1000);
  assert.equal(element.textContent, '두 번째 메시지');
  assert.equal(element.classList.contains('open'), true);

  t.mock.timers.tick(900);
  assert.equal(element.classList.contains('open'), false);
  assert.equal(element.textContent, '두 번째 메시지');
});

test('WordMaster OCR delimiter repairs expose each real meaning as a grading alias', () => {
  const sandbox = { window: {} };
  const source = readFileSync(new URL('../_learning/wordmaster/words.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: '_learning/wordmaster/words.js' });
  const byWord = new Map(sandbox.window.WORDMASTER_WORDS.map((item) => [item.word, item]));

  assert.equal(matchesMeaningAnswer(byWord.get('delight'), '기쁨'), true);
  assert.equal(matchesMeaningAnswer(byWord.get('fuel'), '연료'), true);
  assert.equal(matchesMeaningAnswer(byWord.get('outrage'), '분노'), true);
  assert.doesNotMatch(byWord.get('delight').meaning, /\s0/u);
  assert.doesNotMatch(byWord.get('fuel').meaning, /\s0/u);
  assert.doesNotMatch(byWord.get('outrage').meaning, /\s0/u);
});
