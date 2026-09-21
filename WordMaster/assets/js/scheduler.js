(() => {
  'use strict';

  // Per-word interval scheduling, independently implemented from public spaced-repetition
  // principles. This is not Epop's proprietary algorithm. See docs/WORDMASTER-LEARNING.md.
  const DAY_MS = 86_400_000;
  const RETRY_MS = 10 * 60_000;
  const KST_MS = 9 * 3_600_000;
  const GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const bounded = (value, min, max, fallback = min) => Math.min(max, Math.max(min, number(value, fallback)));
  const integer = (value, min, max, fallback = min) => Math.floor(bounded(value, min, max, fallback));
  const dayKey = (at = Date.now()) => new Date(at + KST_MS).toISOString().slice(0, 10);
  const dayOffset = (key, offset) => new Date(Date.parse(`${key}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
  const validDay = (key) => /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(`${key}T00:00:00Z`));

  function normalizeCard(value, at) {
    const row = object(value);
    return {
      dueAt: bounded(row.dueAt, 0, at + 365 * DAY_MS, at),
      intervalDays: bounded(row.intervalDays, 0, 365),
      ease: bounded(row.ease, 1.3, 3, 2.5),
      repetitions: integer(row.repetitions, 0, 100_000),
      lapses: integer(row.lapses, 0, 100_000),
      lastReviewAt: bounded(row.lastReviewAt, 0, at),
      lastAnsweredAt: bounded(row.lastAnsweredAt, 0, at),
      grade: GRADES.includes(row.grade) ? row.grade : 'again',
    };
  }

  function normalize(value, words, stats = {}, at = Date.now()) {
    const source = object(value);
    const settings = object(source.settings);
    const ids = new Set(words.map((word) => String(word.id)));
    const cards = {};
    for (const id of ids) {
      if (own(object(source.cards), id)) cards[id] = normalizeCard(source.cards[id], at);
      else if (number(stats[id]?.attempts) > 0) {
        // Legacy scores do not establish a recall interval. Verify them once before promoting.
        cards[id] = normalizeCard({ dueAt: at, lastReviewAt: number(stats[id]?.lastAt) }, at);
      }
    }
    const days = {};
    for (const key of Object.keys(object(source.days)).filter(validDay).sort().slice(-366)) {
      const row = object(source.days[key]);
      const attempts = integer(row.attempts, 0, 1_000_000);
      days[key] = {
        count: integer(row.count, 0, ids.size),
        newCount: integer(row.newCount, 0, ids.size),
        reviewCount: integer(row.reviewCount, 0, ids.size),
        attempts,
        correct: integer(row.correct, 0, attempts),
        goal: integer(row.goal, 5, 200, 20),
      };
    }
    const seen = {};
    const today = dayKey(at);
    for (const key of [dayOffset(today, -1), today]) {
      const raw = object(source.seen)[key];
      if (Array.isArray(raw)) seen[key] = [...new Set(raw.filter((id) => typeof id === 'string' && ids.has(id)))];
    }
    const streak = object(source.streak);
    let startDay = integer(settings.startDay, 1, 50, 1);
    let endDay = integer(settings.endDay, 1, 50, 50);
    if (startDay > endDay) [startDay, endDay] = [endDay, startDay];
    return {
      version: 1,
      settings: { goal: integer(settings.goal, 5, 200, 20), startDay, endDay },
      cards,
      days,
      seen,
      streak: { count: integer(streak.count, 0, 100_000), day: validDay(streak.day || '') ? streak.day : '' },
      activeSession: object(source.activeSession).questions ? source.activeSession : null,
    };
  }

  function review(previous, grade, at = Date.now()) {
    if (!GRADES.includes(grade)) throw new TypeError('Unknown recall grade');
    const card = normalizeCard(previous, at);
    if (grade === 'again') {
      return {
        ...card, dueAt: at + RETRY_MS, intervalDays: RETRY_MS / DAY_MS,
        ease: Math.max(1.3, card.ease - 0.2), repetitions: 0, lapses: card.lapses + 1,
        lastReviewAt: at, lastAnsweredAt: at, grade,
      };
    }
    // A just-seen answer is practice, not evidence of long-term recall. Do not grow its interval.
    if (previous && card.lastReviewAt > 0 && at < card.dueAt) {
      return { ...card, lastAnsweredAt: at };
    }
    const ease = Math.min(3, Math.max(1.3, card.ease + (grade === 'easy' ? 0.15 : grade === 'hard' ? -0.15 : 0)));
    let interval;
    if (!card.repetitions) interval = grade === 'easy' ? 3 : grade === 'hard' ? 0.5 : 1;
    else if (card.repetitions === 1) interval = grade === 'easy' ? 7 : grade === 'hard' ? 1 : 3;
    else interval = Math.ceil(card.intervalDays * (grade === 'hard' ? 1.2 : ease * (grade === 'easy' ? 1.3 : 1)));
    interval = Math.min(365, Math.max(0.5, interval));
    return {
      ...card, dueAt: at + interval * DAY_MS, intervalDays: interval, ease,
      repetitions: card.repetitions + 1, lastReviewAt: at, lastAnsweredAt: at, grade,
    };
  }

  function recordDaily(learning, id, correct, isNew, at = Date.now()) {
    const key = dayKey(at);
    const row = learning.days[key] ||= { count: 0, newCount: 0, reviewCount: 0, attempts: 0, correct: 0, goal: learning.settings.goal };
    const seen = learning.seen[key] ||= [];
    row.attempts += 1;
    row.correct += correct ? 1 : 0;
    row.goal = learning.settings.goal;
    if (!seen.includes(String(id))) {
      seen.push(String(id));
      row.count += 1;
      row[isNew ? 'newCount' : 'reviewCount'] += 1;
    }
    if (learning.streak.day !== key) {
      learning.streak = { day: key, count: learning.streak.day === dayOffset(key, -1) ? learning.streak.count + 1 : 1 };
    }
    for (const old of Object.keys(learning.seen)) {
      if (old !== key && old !== dayOffset(key, -1)) delete learning.seen[old];
    }
    for (const old of Object.keys(learning.days).sort().slice(0, -366)) delete learning.days[old];
    return key;
  }

  function dueWords(words, learning, at = Date.now()) {
    return words.filter((word) => learning.cards[word.id]?.dueAt <= at).sort((a, b) => {
      const left = learning.cards[a.id]; const right = learning.cards[b.id];
      return left.dueAt - right.dueAt || right.lapses - left.lapses || a.day - b.day || a.number - b.number;
    });
  }

  function plan(words, learning, mode = 'daily', at = Date.now()) {
    const due = dueWords(words, learning, at);
    const today = learning.days[dayKey(at)];
    const remaining = Math.max(0, learning.settings.goal - (today?.count || 0));
    const limit = mode === 'scheduled' ? 20 : Math.min(20, remaining || 10);
    const fresh = mode === 'scheduled' ? [] : words.filter((word) => (
      !own(learning.cards, word.id) && word.day >= learning.settings.startDay && word.day <= learning.settings.endDay
    )).sort((a, b) => a.day - b.day || a.number - b.number);
    const questions = [...due, ...fresh].slice(0, limit);
    return {
      questions,
      reviewCount: questions.filter((word) => own(learning.cards, word.id)).length,
      newCount: questions.filter((word) => !own(learning.cards, word.id)).length,
      dueCount: due.length,
      remaining,
    };
  }

  function summary(words, learning, at = Date.now()) {
    const key = dayKey(at);
    const today = learning.days[key] || { count: 0, newCount: 0, reviewCount: 0, attempts: 0, correct: 0 };
    const cards = Object.values(learning.cards);
    const due = cards.filter((card) => card.dueAt <= at).length;
    const future = cards.filter((card) => card.dueAt > at);
    const streak = [key, dayOffset(key, -1)].includes(learning.streak.day) ? learning.streak.count : 0;
    return {
      today, due, streak,
      learned: cards.length,
      unseen: Math.max(0, words.length - cards.length),
      stable: cards.filter((card) => card.intervalDays >= 21).length,
      nextDueAt: future.length ? Math.min(...future.map((card) => card.dueAt)) : null,
      week: Array.from({ length: 7 }, (_, index) => {
        const day = dayOffset(key, index - 6); const row = learning.days[day];
        return { day, count: row?.count || 0, goal: row?.goal || learning.settings.goal, today: day === key };
      }),
    };
  }

  function dueLabel(dueAt, at = Date.now()) {
    if (!Number.isFinite(dueAt)) return '예정 없음';
    const delta = dueAt - at;
    if (delta <= 0) return '지금';
    if (delta < 3_600_000) return `${Math.ceil(delta / 60_000)}분 뒤`;
    if (delta < DAY_MS) return `${Math.ceil(delta / 3_600_000)}시간 뒤`;
    return `${Math.ceil(delta / DAY_MS)}일 뒤`;
  }

  function restoreSession(raw, words) {
    if (!raw || !['daily', 'scheduled', 'range', 'review'].includes(raw.mode)) return null;
    if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 4000) return null;
    if (!Number.isInteger(raw.index) || raw.index < 0 || raw.index >= raw.questions.length) return null;
    const byId = new Map(words.map((word) => [String(word.id), word]));
    if (!raw.questions.every((id) => typeof id === 'string' && byId.has(id))) return null;
    const results = Array.isArray(raw.results) ? raw.results : [];
    if (results.length !== raw.index + (raw.answered ? 1 : 0)) return null;
    if (results.some((row) => !byId.has(row.id) || typeof row.correct !== 'boolean' || typeof row.input !== 'string')) return null;
    if (raw.answered && (!raw.lastResult || typeof raw.lastResult.correct !== 'boolean' || typeof raw.lastResult.input !== 'string')) return null;
    return {
      mode: raw.mode, startDay: raw.startDay, endDay: raw.endDay,
      questions: raw.questions.map((id) => byId.get(id)), index: raw.index,
      correct: results.filter((row) => row.correct).length,
      wrong: results.filter((row) => !row.correct).length,
      answered: Boolean(raw.answered), lastResult: raw.answered ? raw.lastResult : null,
      results, startedAt: number(raw.startedAt, Date.now()),
      retries: { ...object(raw.retries) },
      originalCount: integer(raw.originalCount, 1, 2000, raw.questions.length),
    };
  }

  function serializeSession(session) {
    if (!session) return null;
    return { ...session, questions: session.questions.map((word) => String(word.id)) };
  }

  globalThis.HvsWordmasterScheduler = Object.freeze({
    DAY_MS, RETRY_MS, GRADES, dayKey, dayOffset, normalize, review,
    recordDaily, dueWords, plan, summary, dueLabel, restoreSession, serializeSession,
  });
})();
