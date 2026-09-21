import test from 'node:test';
import assert from 'node:assert/strict';
import '../WordMaster/assets/js/scheduler.js';

const s = globalThis.HvsWordmasterScheduler;
const at = Date.parse('2026-09-21T03:00:00Z');
const words = Array.from({ length: 2000 }, (_, i) => ({ id: `w${i + 1}`, day: Math.floor(i / 40) + 1, number: i % 40 + 1 }));
const fresh = () => s.normalize(null, words, {}, at);

test('Korean daily boundaries are independent of device timezone', () => {
  assert.equal(s.dayKey(Date.parse('2026-09-21T14:59:59Z')), '2026-09-21');
  assert.equal(s.dayKey(Date.parse('2026-09-21T15:00:00Z')), '2026-09-22');
  assert.equal(s.dayOffset('2026-01-01', -1), '2025-12-31');
});
test('legacy attempts migrate to due review without mutating original scores', () => {
  const stats = { w1: { attempts: 7, correct: 6, wrong: 1, lastAt: at - 5000 } };
  const before = JSON.stringify(stats);
  const data = s.normalize(null, words, stats, at);
  assert.equal(data.cards.w1.dueAt, at);
  assert.equal(data.cards.w1.repetitions, 0);
  assert.equal(JSON.stringify(stats), before);
  assert.equal(Object.keys(data.cards).length, 1);
});
test('first good, hard and easy recall have explicit distinct intervals', () => {
  assert.equal(s.review(null, 'good', at).dueAt, at + s.DAY_MS);
  assert.equal(s.review(null, 'hard', at).dueAt, at + s.DAY_MS / 2);
  assert.equal(s.review(null, 'easy', at).dueAt, at + 3 * s.DAY_MS);
  assert.throws(() => s.review(null, 'unknown', at), TypeError);
});
test('incorrect answer becomes due in ten minutes and resets repetition', () => {
  const old = { ...s.review(null, 'easy', at), repetitions: 8, intervalDays: 90, ease: 1.3 };
  const next = s.review(old, 'again', at + s.DAY_MS);
  assert.equal(next.dueAt, at + s.DAY_MS + s.RETRY_MS);
  assert.equal(next.repetitions, 0);
  assert.equal(next.lapses, 1);
  assert.equal(next.ease, 1.3);
});
test('practice before due time never inflates the interval', () => {
  const old = s.review(null, 'again', at);
  const next = s.review(old, 'easy', at + 1000);
  assert.equal(next.dueAt, old.dueAt);
  assert.equal(next.repetitions, old.repetitions);
  assert.equal(next.lastReviewAt, at);
  assert.equal(next.lastAnsweredAt, at + 1000);
});
test('due successful reviews grow with bounded ease and intervals', () => {
  let card = s.review(null, 'good', at);
  card = s.review(card, 'good', card.dueAt);
  assert.equal(card.intervalDays, 3);
  for (let i = 0; i < 100; i++) card = s.review(card, 'easy', card.dueAt);
  assert.equal(card.intervalDays, 365);
  assert.equal(card.ease, 3);
});
test('overdue reviews come before new words and ignore the new-word DAY range', () => {
  const data = fresh();
  data.settings = { goal: 5, startDay: 2, endDay: 2 };
  data.cards.w1 = { ...s.review(null, 'again', at - 2 * s.RETRY_MS) };
  data.cards.w2 = { ...s.review(null, 'again', at - 3 * s.RETRY_MS) };
  data.cards.w3 = s.review(null, 'good', at);
  const plan = s.plan(words, data, 'daily', at);
  assert.deepEqual(plan.questions.map(w => w.id), ['w2', 'w1', 'w41', 'w42', 'w43']);
  assert.equal(plan.reviewCount, 2);
  assert.equal(plan.newCount, 3);
  assert.deepEqual(s.plan(words, data, 'scheduled', at).questions.map(w => w.id), ['w2', 'w1']);
});
test('daily goal counts distinct words but retains actual attempts and accuracy', () => {
  const data = fresh();
  s.recordDaily(data, 'w1', false, true, at);
  s.recordDaily(data, 'w1', true, false, at + 1000);
  s.recordDaily(data, 'w2', true, false, at + 2000);
  const row = data.days[s.dayKey(at)];
  assert.deepEqual([row.count, row.newCount, row.reviewCount, row.attempts, row.correct], [2, 1, 1, 3, 2]);
  assert.equal(s.plan(words, data, 'daily', at).questions.length, 18);
});
test('KST midnight resets day counts; streak continues only across adjacent days', () => {
  const data = fresh();
  s.recordDaily(data, 'w1', true, true, at);
  s.recordDaily(data, 'w1', true, false, at + s.DAY_MS);
  assert.equal(data.streak.count, 2);
  assert.equal(s.summary(words, data, at + s.DAY_MS).today.count, 1);
  assert.equal(s.summary(words, data, at + 3 * s.DAY_MS).streak, 0);
  s.recordDaily(data, 'w2', true, true, at + 4 * s.DAY_MS);
  assert.equal(data.streak.count, 1);
});
test('daily batches are bounded; extra study is available after goal completion', () => {
  const data = fresh(); data.settings.goal = 200;
  assert.equal(s.plan(words, data, 'daily', at).questions.length, 20);
  data.settings.goal = 5;
  for (let i = 1; i <= 5; i++) { s.recordDaily(data, `w${i}`, true, true, at); data.cards[`w${i}`] = s.review(null, 'good', at); }
  assert.equal(s.plan(words, data, 'daily', at).questions.length, 10);
});
test('empty review and fully learned collections produce no phantom questions', () => {
  const data = fresh();
  assert.equal(s.plan(words, data, 'scheduled', at).questions.length, 0);
  for (const word of words) data.cards[word.id] = s.review(null, 'good', at);
  assert.equal(s.plan(words, data, 'daily', at).questions.length, 0);
  assert.equal(s.summary(words, data, at).nextDueAt, at + s.DAY_MS);
});
test('normalization rejects unknown IDs and bounds corrupt settings and cards', () => {
  const data = s.normalize({ settings: { goal: NaN, startDay: 50, endDay: 2 }, cards: { unknown: {}, w1: { ease: -99, intervalDays: Infinity, repetitions: -1 } } }, words, {}, at);
  assert.equal(data.settings.goal, 20);
  assert.deepEqual([data.settings.startDay, data.settings.endDay], [2, 50]);
  assert.equal(data.cards.w1.ease, 1.3);
  assert.equal(data.cards.w1.repetitions, 0);
  assert.equal(data.cards.unknown, undefined);
});
test('resume roundtrip preserves answered position without counting again', () => {
  const session = { mode: 'daily', questions: words.slice(0, 2), index: 0, answered: true, results: [{ id: 'w1', correct: true, input: 'answer' }], lastResult: { correct: true, input: 'answer', at, cardBefore: null, grade: 'good' }, originalCount: 2, retries: {}, startedAt: at };
  const restored = s.restoreSession(s.serializeSession(session), words);
  assert.equal(restored.questions[0].id, 'w1');
  assert.equal(restored.answered, true);
  assert.equal(restored.correct, 1);
  assert.equal(s.restoreSession({ ...s.serializeSession(session), index: 2001 }, words), null);
  assert.equal(s.restoreSession({ ...s.serializeSession(session), questions: ['deleted'] }, words), null);
});
test('storage is bounded and a complete 2000-word schedule fits the existing sync limit', () => {
  const data = fresh();
  for (const word of words) { data.cards[word.id] = s.review(null, 'good', at); s.recordDaily(data, word.id, true, true, at); }
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 600_000);
  for (let i = 1; i <= 400; i++) s.recordDaily(data, 'w1', true, false, at + i * s.DAY_MS);
  assert.ok(Object.keys(data.days).length <= 366);
  assert.ok(Object.keys(data.seen).length <= 2);
});
