import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  fixedTimeEqual,
  fixedTimeTextEqual,
} from './src/router.js';
import {
  DAY_MS,
  clientIp,
  createToken,
  issueSession,
  normalizeAnswer,
  passwordHash,
  readJson,
  sha256,
} from './src/lib.js';

const ROUTER_SOURCE = readFileSync(new URL('./src/router.js', import.meta.url), 'utf8');
const COMPETITION_REPORTER_FIXTURE = JSON.parse(readFileSync(
  new URL('../scripts/fixtures/competition-report.valid.json', import.meta.url),
  'utf8',
));

function createLoginTestDb(user = null) {
  const limits = new Map();
  const sessions = [];
  let userLookups = 0;

  return {
    limits,
    sessions,
    get userLookups() { return userLookups; },
    resetMinuteWindows() {
      for (const state of limits.values()) state.minuteStartedAt = Date.now() - 60_001;
    },
    prepare(sql) {
      const query = sql.replace(/\s+/gu, ' ').trim();
      return {
        bind(...values) {
          if (query.startsWith('INSERT INTO login_attempt_limits')) {
            return {
              async first() {
                const [keyHash, attemptedAt, minuteCutoff] = values;
                let state = limits.get(keyHash);
                if (!state) {
                  state = {
                    minuteStartedAt: attemptedAt,
                    minuteAttempts: 1,
                    failureWindowStartedAt: null,
                    failureCount: 0,
                    lockedUntil: 0,
                    updatedAt: attemptedAt,
                  };
                  limits.set(keyHash, state);
                } else if (state.minuteStartedAt <= minuteCutoff) {
                  state.minuteStartedAt = attemptedAt;
                  state.minuteAttempts = 1;
                  state.updatedAt = attemptedAt;
                } else {
                  state.minuteAttempts += 1;
                  state.updatedAt = attemptedAt;
                }
                return {
                  minute_started_at: state.minuteStartedAt,
                  minute_attempts: state.minuteAttempts,
                  locked_until: state.lockedUntil,
                };
              },
            };
          }

          if (query.startsWith('UPDATE login_attempt_limits SET failure_window_started_at = CASE')) {
            return {
              async first() {
                const [keyHash, attemptedAt, failureCutoff, lockUntil, failureLimit] = values;
                const state = limits.get(keyHash);
                assert.ok(state, 'attempt counter must exist before recording a failure');
                const resetFailures = state.failureWindowStartedAt === null
                  || state.failureWindowStartedAt <= failureCutoff;
                state.failureWindowStartedAt = resetFailures
                  ? attemptedAt
                  : state.failureWindowStartedAt;
                state.failureCount = resetFailures ? 1 : state.failureCount + 1;
                if (state.failureCount >= failureLimit) {
                  state.lockedUntil = Math.max(state.lockedUntil, lockUntil);
                }
                state.updatedAt = attemptedAt;
                return {
                  failure_count: state.failureCount,
                  locked_until: state.lockedUntil,
                };
              },
            };
          }

          if (query.startsWith('UPDATE login_attempt_limits SET failure_window_started_at = NULL')) {
            return {
              async run() {
                const [keyHash, attemptedAt] = values;
                const state = limits.get(keyHash);
                assert.ok(state, 'attempt counter must exist before clearing failures');
                state.failureWindowStartedAt = null;
                state.failureCount = 0;
                state.lockedUntil = 0;
                state.updatedAt = attemptedAt;
                return { success: true };
              },
            };
          }

          if (query.startsWith('SELECT * FROM users WHERE username = ?')) {
            return {
              async first() {
                userLookups += 1;
                return user && user.username.toLowerCase() === String(values[0]).toLowerCase()
                  ? user
                  : null;
              },
            };
          }

          if (query.startsWith('INSERT INTO sessions')) {
            return {
              async run() {
                const allowed = values.length === 9 || (user && !user.disabled
                  && values[9] === user.id && values[10] === user.password_hash);
                if (allowed) sessions.push(values);
                return { success: true, meta: { changes: allowed ? 1 : 0 } };
              },
            };
          }

          if (query.startsWith('UPDATE users SET last_login_at')
            || query.startsWith('INSERT INTO activity')) {
            return { async run() { return { success: true }; } };
          }

          throw new Error(`Unexpected login SQL in test: ${query}`);
        },
      };
    },
  };
}

function loginRequest(path, body, ip = '198.51.100.40') {
  return new Request(`https://api.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

test('client IP uses the Cloudflare address and enforces a storage limit', () => {
  const request = new Request('https://api.test', {
    headers: { 'cf-connecting-ip': '2001:db8::1234' },
  });
  assert.equal(clientIp(request), '2001:db8::1234');
  assert.equal(clientIp(new Request('https://api.test')), 'unknown');
  assert.equal(clientIp(new Request('https://api.test', {
    headers: { 'cf-connecting-ip': '   ' },
  })), 'unknown');
  assert.equal(clientIp(new Request('https://api.test', {
    headers: { 'cf-connecting-ip': 'a'.repeat(100) },
  })).length, 64);
});

test('issued sessions persist IP and device metadata without storing the raw token', async () => {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            calls.push({ sql, values });
            return { async run() { return { success: true }; } };
          },
        };
      },
    },
  };
  const request = new Request('https://api.test', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': 'Example Browser',
    },
  });
  const rawToken = await issueSession(env, 7, 'user', request);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ip_address/u);
  assert.equal(calls[0].values[7], '203.0.113.7');
  assert.equal(calls[0].values[8], 'Example Browser');
  assert.notEqual(calls[0].values[0], rawToken);
});

test('answer normalization is stable for spacing and punctuation', () => {
  assert.equal(normalizeAnswer('  사회·문화 (현상)! '), '사회문화현상');
  assert.equal(normalizeAnswer('Ａ-B_C'), 'abc');
});

test('hash helpers are deterministic and tokens are URL-safe', async () => {
  assert.equal(
    await sha256('hvsdcm'),
    'ce64ad5e16daaa12f3ca200b1179791133d48ae2803c3c70f087e3b7e77c27ed',
  );
  assert.equal(await passwordHash('password', 'salt'), await passwordHash('password', 'salt'));
  assert.match(createToken(), /^[A-Za-z0-9_-]{43}$/);
});

test('login text comparison uses fixed-length constant-time bytes', async () => {
  assert.equal(fixedTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(fixedTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(await fixedTimeTextEqual('same password', 'same password'), true);
  assert.equal(await fixedTimeTextEqual('short', 'a different-length password'), false);
});

test('login routes retain atomic D1 counters and fixed-time password calls', () => {
  assert.match(ROUTER_SOURCE, /const LOGIN_ATTEMPTS_PER_MINUTE = 5;/u);
  assert.match(ROUTER_SOURCE, /const LOGIN_FAILURES_PER_WINDOW = 10;/u);
  assert.match(ROUTER_SOURCE, /const LOGIN_LOCK_MS = 15 \* LOGIN_MINUTE_MS;/u);
  assert.match(
    ROUTER_SOURCE,
    /INSERT INTO login_attempt_limits[\s\S]*ON CONFLICT\(key_hash\) DO UPDATE SET[\s\S]*login_attempt_limits\.minute_attempts \+ 1[\s\S]*RETURNING minute_started_at, minute_attempts, locked_until/u,
  );
  assert.match(
    ROUTER_SOURCE,
    /UPDATE login_attempt_limits[\s\S]*SET failure_window_started_at = CASE[\s\S]*failure_count \+ 1[\s\S]*>= \?5 THEN MAX\(locked_until, \?4\)[\s\S]*RETURNING failure_count, locked_until/u,
  );

  const userLogin = /async function login\([\s\S]*?\n\}\n\nasync function adminLogin/u.exec(ROUTER_SOURCE)?.[0] || '';
  const adminLogin = /async function adminLogin\([\s\S]*?\n\}\n\nasync function ingestTokenMatches/u.exec(ROUTER_SOURCE)?.[0] || '';
  assert.match(userLogin, /await fixedTimeTextEqual\(suppliedHash, user\.password_hash\)/u);
  assert.match(userLogin, /if \(!user \|\| user\.disabled \|\| !passwordMatches\)/u);
  assert.match(adminLogin, /await fixedTimeTextEqual\([\s\S]*String\(env\.ADMIN_PASSWORD \|\| ''\)/u);
  assert.match(adminLogin, /if \(!env\.ADMIN_PASSWORD \|\| !passwordMatches\)/u);
});

test('login limiter key combines route, normalized account, and client IP without raw metadata', async () => {
  const db = createLoginTestDb();
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: db,
  };
  const userAttempt = (username, ip) => worker.fetch(loginRequest('/api/login', {
    username, password: 'wrong',
  }, ip), env);

  assert.equal((await userAttempt('Student', '198.51.100.1')).status, 401);
  assert.equal((await userAttempt('student', '198.51.100.1')).status, 401);
  assert.equal(db.limits.size, 1, 'account case variants must share one counter');

  assert.equal((await userAttempt('other', '198.51.100.1')).status, 401);
  assert.equal((await userAttempt('student', '198.51.100.2')).status, 401);
  assert.equal((await userAttempt('admin', '198.51.100.1')).status, 401);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'wrong',
  }, '198.51.100.1'), env)).status, 401);
  assert.equal(db.limits.size, 5, 'account, IP, and route changes must each select a distinct counter');
  for (const key of db.limits.keys()) assert.match(key, /^[a-f0-9]{64}$/u);
});

test('user and admin login allow five attempts per minute and reject the sixth', async () => {
  const cases = [
    { path: '/api/login', body: { username: 'student', password: 'wrong' } },
    { path: '/api/admin/login', body: { password: 'wrong' } },
  ];

  for (const current of cases) {
    const db = createLoginTestDb();
    const env = {
      ADMIN_PASSWORD: 'correct-password',
      ALLOWED_ORIGIN: 'https://example.test',
      DB: db,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} attempt ${attempt}`);
    }

    const limited = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(limited.status, 429, current.path);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.ok(Number(limited.headers.get('retry-after')) <= 60);
  }
});

test('user and admin login lock for fifteen minutes on the tenth hourly failure', async () => {
  const cases = [
    { path: '/api/login', body: { username: 'student', password: 'wrong' } },
    { path: '/api/admin/login', body: { password: 'wrong' } },
  ];

  for (const current of cases) {
    const db = createLoginTestDb();
    const env = {
      ADMIN_PASSWORD: 'correct-password',
      ALLOWED_ORIGIN: 'https://example.test',
      DB: db,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} failure ${attempt}`);
    }
    db.resetMinuteWindows();
    for (let attempt = 6; attempt <= 9; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} failure ${attempt}`);
    }

    const locked = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(locked.status, 429, current.path);
    assert.equal(Number(locked.headers.get('retry-after')), 900);

    const lookupsBeforeLockedRetry = db.userLookups;
    const lockedRetry = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(lockedRetry.status, 429, current.path);
    assert.ok(Number(lockedRetry.headers.get('retry-after')) >= 899);
    assert.equal(db.userLookups, lookupsBeforeLockedRetry, 'locked requests must skip credential lookup');
  }
});

test('successful user and admin login clear only their failure lock state', async () => {
  const passwordSalt = 'test-salt';
  const db = createLoginTestDb({
    id: 7,
    username: 'student',
    password_salt: passwordSalt,
    password_hash: await passwordHash('correct-password', passwordSalt),
    disabled: 0,
  });
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: db,
  };

  assert.equal((await worker.fetch(loginRequest('/api/login', {
    username: 'student', password: 'wrong',
  }), env)).status, 401);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'wrong',
  }), env)).status, 401);

  assert.equal((await worker.fetch(loginRequest('/api/login', {
    username: 'student', password: 'correct-password',
  }), env)).status, 200);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'correct-password',
  }), env)).status, 200);

  assert.equal(db.sessions.length, 2);
  for (const state of db.limits.values()) {
    assert.equal(state.failureCount, 0);
    assert.equal(state.minuteAttempts, 2, 'a success must not reset the per-minute attempt counter');
  }
});

test('invalid JSON request bodies resolve to an empty object', async () => {
  const request = new Request('https://example.test/api', {
    method: 'POST',
    body: '{broken',
  });
  assert.deepEqual(await readJson(request), {});
});

test('OPTIONS and unknown routes include CORS headers', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test' };
  const options = await worker.fetch(new Request('https://api.test/api/me', {
    method: 'OPTIONS',
  }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);

  const missing = await worker.fetch(new Request('https://api.test/not-found'), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
  assert.equal(missing.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
});

const GICHUL_USER_TOKEN_HASH = await sha256('user-token');
const GICHUL_DISABLED_TOKEN_HASH = await sha256('disabled-token');

function createGichulEnv({ exams = [], pdfs = new Map(), learningObjects = new Map(), manifestExists = true } = {}) {
  const r2Reads = [];
  const manifest = { exams };
  return {
    ALLOWED_ORIGIN: 'https://hvsdcm1.xyz',
    r2Reads,
    DB: {
      prepare(sql) {
        const query = sql.replace(/\s+/gu, ' ').trim();
        return {
          bind(...values) {
            if (query.startsWith('SELECT s.*, u.username, u.disabled FROM sessions')) {
              return {
                async first() {
                  if (values[0] === GICHUL_DISABLED_TOKEN_HASH) {
                    return {
                      token_hash: values[0], user_id: 8, role: 'user', username: 'disabled', disabled: 1,
                    };
                  }
                  if (values[0] !== GICHUL_USER_TOKEN_HASH) return null;
                  return {
                    token_hash: values[0], user_id: 7, role: 'user', username: 'learner', disabled: 0,
                  };
                },
              };
            }
            if (query.startsWith('UPDATE sessions SET last_seen_at')) {
              return { async run() { return { success: true }; } };
            }
            throw new Error(`Unexpected gichul SQL in test: ${query}`);
          },
        };
      },
    },
    GICHUL: {
      async get(key) {
        r2Reads.push(key);
        if (learningObjects.has(key)) return { body: learningObjects.get(key) };
        if (key === 'manifest.json') {
          if (!manifestExists) return null;
          return {
            body: JSON.stringify(manifest),
            async json() { return manifest; },
          };
        }
        const body = pdfs.get(key);
        return body === undefined ? null : { body };
      },
    },
  };
}

test('gichul manifest and PDF routes reject anonymous requests before reading R2', async () => {
  const env = createGichulEnv();
  for (const authorization of [null, 'Bearer bogus-token', 'Bearer expired-token', 'Bearer disabled-token']) {
    for (const path of ['/api/gichul/manifest', '/api/gichul/pdf/2024-06-korean-hwajak-question']) {
      const headers = authorization ? { authorization } : undefined;
      const response = await worker.fetch(new Request(`https://api.test${path}`, { headers }), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
    }
  }
  assert.deepEqual(env.r2Reads, []);
});

test('learning content and images reject anonymous requests before reading R2', async () => {
  const env = createGichulEnv();
  for (const path of [
    '/api/learning/wordmaster',
    '/api/learning/smstudy',
    '/api/learning/plstudy',
    '/api/learning/smstudy/image/2026-csat-01.webp',
  ]) {
    const response = await worker.fetch(new Request(`https://api.test${path}`), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(env.r2Reads, []);
});

test('authenticated learning routes stream only fixed R2 keys', async () => {
  const objects = new Map([
    ['learning/wordmaster.json', JSON.stringify({ words: [{ id: 'fixture' }], emoji: {} })],
    ['learning/smstudy.json', JSON.stringify({ data: {}, notebook: {}, explanations: {} })],
    ['learning/plstudy.json', JSON.stringify({ data: { UNITS: [], QUESTIONS: [] } })],
    ['learning/smstudy/kice/2026-csat-01.webp', new Uint8Array([82, 73, 70, 70])],
  ]);
  const env = createGichulEnv({ learningObjects: objects });
  const headers = { authorization: 'Bearer user-token' };

  const words = await worker.fetch(new Request('https://api.test/api/learning/wordmaster', { headers }), env);
  assert.equal(words.status, 200);
  assert.match(words.headers.get('content-type'), /^application\/json/u);
  assert.equal(words.headers.get('cache-control'), 'no-store');
  assert.equal((await words.json()).words[0].id, 'fixture');

  const politics = await worker.fetch(new Request('https://api.test/api/learning/plstudy', { headers }), env);
  assert.equal(politics.status, 200);
  assert.deepEqual((await politics.json()).data.UNITS, []);

  const image = await worker.fetch(new Request('https://api.test/api/learning/smstudy/image/2026-csat-01.webp', { headers }), env);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['learning/wordmaster.json', 'learning/plstudy.json', 'learning/smstudy/kice/2026-csat-01.webp']);

  const invalid = await worker.fetch(new Request('https://api.test/api/learning/smstudy/image/not-a-webp.txt', { headers }), env);
  assert.equal(invalid.status, 404);
  assert.equal(env.r2Reads.length, 3);
});

test('politics and law progress plus shared answers use the same authenticated account contract', async () => {
  const writes = [];
  const env = {
    ALLOWED_ORIGIN: 'https://hvsdcm1.xyz',
    DB: {
      prepare(sql) {
        const query = sql.replace(/\s+/gu, ' ').trim();
        return {
          bind(...values) {
            if (query.startsWith('SELECT s.*, u.username, u.disabled FROM sessions')) {
              return { async first() { return { user_id: 7, role: 'user', username: 'learner', disabled: 0 }; } };
            }
            if (query.startsWith('UPDATE sessions SET last_seen_at')) {
              return { async run() { return { success: true }; } };
            }
            if (query.startsWith('SELECT data, updated_at FROM progress')) {
              return { async first() { return null; } };
            }
            if (query.startsWith('INSERT INTO progress')) {
              return { async run() { writes.push({ kind: 'progress', values }); return { success: true }; } };
            }
            if (query.startsWith('SELECT question_id, display_answer FROM shared_answers')) {
              return { async all() { return { results: [] }; } };
            }
            if (query.startsWith('INSERT INTO activity')) {
              return { async run() { writes.push({ kind: 'activity', values }); return { success: true }; } };
            }
            throw new Error(`Unexpected politics account SQL in test: ${query}`);
          },
        };
      },
    },
  };
  const headers = { authorization: 'Bearer user-token' };

  const readProgress = await worker.fetch(new Request('https://api.test/api/progress/plstudy', { headers }), env);
  assert.equal(readProgress.status, 200);
  assert.deepEqual(await readProgress.json(), { data: null, updatedAt: 0 });

  const writeProgress = await worker.fetch(new Request('https://api.test/api/progress/plstudy', {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ data: { 'I-01': { answered: 1, correct: 1 } } }),
  }), env);
  assert.equal(writeProgress.status, 200);
  assert.equal(writes.filter((entry) => entry.kind === 'progress').length, 1);

  const answers = await worker.fetch(new Request('https://api.test/api/answers/plstudy', { headers }), env);
  assert.equal(answers.status, 200);
  assert.deepEqual(await answers.json(), { answers: [] });
});

test('an unchanged shared answer does not add another activity event', async () => {
  let activityWrites = 0;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        const query = sql.replace(/\s+/gu, ' ').trim();
        return {
          bind() {
            if (query.startsWith('SELECT s.*, u.username, u.disabled FROM sessions')) {
              return { async first() { return { user_id: 7, role: 'user', username: 'learner', disabled: 0 }; } };
            }
            if (query.startsWith('UPDATE sessions SET last_seen_at')) {
              return { async run() { return { success: true }; } };
            }
            if (query.startsWith('INSERT INTO shared_answers')) {
              assert.match(query, /WHERE \(excluded\.question_label != ''/u);
              return { async run() { return { success: true, meta: { changes: 0 } }; } };
            }
            if (query.startsWith('INSERT INTO activity')) {
              return { async run() { activityWrites += 1; return { success: true }; } };
            }
            throw new Error(`Unexpected shared answer SQL in test: ${query}`);
          },
        };
      },
    },
  };
  const response = await worker.fetch(new Request('https://api.test/api/answers/accept', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'wordmaster', questionId: 'd01-01', answer: '뜻' }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(activityWrites, 0);
});

test('authenticated gichul routes stream only manifest-mapped PDFs with no-store CORS', async () => {
  const id = '2024-06-korean-hwajak-question';
  const pdfBytes = new TextEncoder().encode('%PDF-fixture');
  const env = createGichulEnv({
    exams: [{ id, r2_key: 'papers/shared-korean.pdf' }],
    pdfs: new Map([['papers/shared-korean.pdf', pdfBytes]]),
  });
  const headers = { authorization: 'Bearer user-token' };

  const manifest = await worker.fetch(new Request('https://api.test/api/gichul/manifest', { headers }), env);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(manifest.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await manifest.json(), { exams: [{ id, r2_key: 'papers/shared-korean.pdf' }] });

  const pdf = await worker.fetch(new Request(`https://api.test/api/gichul/pdf/${id}`, { headers }), env);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('cache-control'), 'no-store');
  assert.equal(pdf.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
  assert.deepEqual(new Uint8Array(await pdf.arrayBuffer()), pdfBytes);
  assert.deepEqual(env.r2Reads, ['manifest.json', 'manifest.json', 'papers/shared-korean.pdf']);
});

test('authenticated gichul PDF lookup returns 404 without arbitrary R2 key access', async () => {
  const env = createGichulEnv({
    exams: [{ id: 'known-id', r2_key: 'paper.pdf' }],
  });
  const headers = { authorization: 'Bearer user-token' };
  const missing = await worker.fetch(new Request('https://api.test/api/gichul/pdf/missing-id', { headers }), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['manifest.json']);

  const invalid = await worker.fetch(new Request('https://api.test/api/gichul/pdf/%2e%2e%2fsecret', { headers }), env);
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['manifest.json']);
});

test('authenticated gichul routes return 404 when the R2 manifest or mapped object is absent', async () => {
  const headers = { authorization: 'Bearer user-token' };
  const noManifest = createGichulEnv({ manifestExists: false });
  assert.equal((await worker.fetch(new Request('https://api.test/api/gichul/manifest', { headers }), noManifest)).status, 404);

  const noPdf = createGichulEnv({ exams: [{ id: 'known-id', r2_key: 'missing.pdf' }] });
  const response = await worker.fetch(new Request('https://api.test/api/gichul/pdf/known-id', { headers }), noPdf);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unexpected gichul storage failures stay generic, CORS-enabled, and no-store', async () => {
  const env = createGichulEnv();
  env.GICHUL.get = async () => ({
    async json() { throw new Error('corrupt R2 manifest detail'); },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request('https://api.test/api/gichul/pdf/known-id', {
      headers: { authorization: 'Bearer user-token' },
    }), env);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
    assert.deepEqual(await response.json(), { error: '서버 오류' });
  } finally {
    console.error = originalError;
  }
});

test('admin login rejects an incorrect password before issuing a session', async () => {
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: createLoginTestDb(),
  };
  const response = await worker.fetch(new Request('https://api.test/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: '비밀번호가 올바르지 않습니다.' });
});

test('admin session route returns device metadata without token hashes', async () => {
  const timestamp = Date.now();
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (sql.includes('SELECT s.*, u.username')) {
              return { async first() { return { token_hash: 'stored-admin-hash', role: 'admin', disabled: 0 }; } };
            }
            if (sql.includes('UPDATE sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('DELETE FROM sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('INNER JOIN users')) {
              return {
                async all() {
                  return {
                    results: [{
                      user_id: 3,
                      username: 'tester',
                      created_at: timestamp - 1_000,
                      expires_at: timestamp + 60_000,
                      last_seen_at: timestamp,
                      ip_address: '203.0.113.8',
                      ip_fingerprint: '1234567890ab',
                      user_agent: 'Example Browser',
                    }],
                  };
                },
              };
            }
            throw new Error(`Unexpected SQL in test: ${sql}`);
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/admin/sessions', {
    headers: {
      authorization: 'Bearer admin-token',
      'cf-connecting-ip': '198.51.100.1',
      'user-agent': 'Admin Browser',
    },
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.sessions[0].active, true);
  assert.equal(data.sessions[0].ip_address, '203.0.113.8');
  assert.equal(data.sessions[0].ip_fingerprint, '1234567890ab');
  assert.equal('ip_hash' in data.sessions[0], false);
  assert.equal('token_hash' in data.sessions[0], false);
});

test('admin user statistics include the latest activity time separately from login', async () => {
  const lastLoginAt = Date.now() - 60_000;
  const lastActivityAt = Date.now();
  let userQuery = '';
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (sql.includes('SELECT s.*, u.username')) {
              return { async first() { return { token_hash: 'stored-admin-hash', role: 'admin', disabled: 0 }; } };
            }
            if (sql.includes('UPDATE sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('FROM users u')) {
              userQuery = sql;
              return {
                async all() {
                  return {
                    results: [{
                      id: 3,
                      username: 'tester',
                      created_at: lastLoginAt - 60_000,
                      last_login_at: lastLoginAt,
                      last_activity_at: lastActivityAt,
                      active_devices: 1,
                      recent_ip: '203.0.113.8',
                      logins: 2,
                      word_events: 5,
                      sm_events: 4,
                      pl_events: 3,
                    }],
                  };
                },
              };
            }
            throw new Error(`Unexpected SQL in test: ${sql}`);
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/admin/users', {
    headers: {
      authorization: 'Bearer admin-token',
      'cf-connecting-ip': '198.51.100.1',
      'user-agent': 'Admin Browser',
    },
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.users[0].last_login_at, lastLoginAt);
  assert.equal(data.users[0].last_activity_at, lastActivityAt);
  assert.match(userQuery, /MAX\(activity_session\.last_seen_at\)/u);
  assert.match(userQuery, /activity_session\.role = 'user'/u);
  assert.match(userQuery, /a\.app = 'plstudy'/u);
});

test('logout expires the session but preserves its audit record', async () => {
  let updateCall;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        assert.match(sql, /UPDATE sessions/u);
        assert.doesNotMatch(sql, /DELETE FROM sessions/u);
        return {
          bind(...values) {
            updateCall = { sql, values };
            return { async run() { return { success: true }; } };
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/logout', {
    method: 'POST',
    headers: {
      authorization: 'Bearer user-token',
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Logout Browser',
    },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(updateCall.values[3], '203.0.113.9');
  assert.equal(updateCall.values[4], 'Logout Browser');
});

test('archived usage and harness routes return 404 regardless of bearer role', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test' };
  for (const authorization of ['', 'Bearer user-token', 'Bearer owner-token', 'Bearer admin-token']) {
    for (const [method, path] of [
      ['GET', '/api/usage'],
      ['POST', '/api/usage/report'],
      ['POST', '/api/harness/report'],
    ]) {
      const headers = authorization ? { authorization } : {};
      const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers }), env);
      assert.equal(response.status, 404, `${authorization || 'anonymous'} ${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'Not found' });
    }
  }
});

function sqliteD1(database) {
  let batchTail = Promise.resolve();
  const wrap = (statement, values = []) => ({
    bind(...nextValues) { return wrap(statement, nextValues); },
    async first() {
      const row = statement.get(...values);
      return row === undefined ? null : { ...row };
    },
    async all() {
      return { results: statement.all(...values).map((row) => ({ ...row })) };
    },
    async run() {
      const result = statement.run(...values);
      return {
        success: true,
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid || 0),
        },
      };
    },
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    batch(statements) {
      const execute = async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          database.exec('COMMIT');
          return results;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      };
      const result = batchTail.then(execute, execute);
      batchTail = result.catch(() => {});
      return result;
    },
  };
}

async function competitionDatabaseContext(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return null;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (let number = 1; number <= 19; number += 1) {
    const prefix = String(number).padStart(4, '0');
    const migrationNames = {
      '0001': 'init',
      '0002': 'answer_labels',
      '0003': 'answer_context',
      '0004': 'session_ip_address',
      '0005': 'usage_snapshots',
      '0006': 'harness_tasks',
      '0007': 'harness_events',
      '0008': 'login_attempt_limits',
      '0009': 'usage_health_harness_heartbeat',
      '0010': 'harness_project_snapshots',
      '0011': 'moderator_control_plane',
      '0012': 'moderator_read_state',
      '0013': 'moderator_backfill_read',
      '0014': 'competitions',
      '0015': 'competition_candidate_capacity',
      '0016': 'competition_approval_requests',
      '0017': 'competition_approval_report_links',
      '0018': 'competition_preference_contract',
      '0019': 'competition_closed_application_continuity',
    };
    const sql = readFileSync(
      new URL(`./migrations/${prefix}_${migrationNames[prefix]}.sql`, import.meta.url),
      'utf8',
    );
    database.exec(sql);
  }
  const createdAt = Date.now();
  const owner = database.prepare(`
    INSERT INTO users(username, password_hash, password_salt, created_at, disabled)
    VALUES ('hvsdcm', 'unused', 'unused', ?, 0)
  `).run(createdAt);
  const student = database.prepare(`
    INSERT INTO users(username, password_hash, password_salt, created_at, disabled)
    VALUES ('student', 'unused', 'unused', ?, 0)
  `).run(createdAt);
  const insertSession = database.prepare(`
    INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `);
  insertSession.run(
    await sha256('owner-token'),
    Number(owner.lastInsertRowid),
    createdAt,
    createdAt + DAY_MS,
    createdAt,
  );
  insertSession.run(
    await sha256('student-token'),
    Number(student.lastInsertRowid),
    createdAt,
    createdAt + DAY_MS,
    createdAt,
  );
  return {
    database,
    env: {
      ALLOWED_ORIGIN: 'https://example.test',
      OWNER_USERNAME: 'hvsdcm',
      DB: sqliteD1(database),
    },
  };
}


const COMPETITION_PROFILE_ID = `hmac-sha256:${'0123456789abcdef'.repeat(4)}`;
const COMPETITION_KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

function competitionKstDate(milliseconds) {
  return new Date(milliseconds + COMPETITION_KST_OFFSET_MS).toISOString().slice(0, 10);
}

function setCompetitionTimeline(fixture, startedAt) {
  const start = Math.floor(startedAt / 1_000) * 1_000;
  const finished = start + 5 * 60_000;
  fixture.run.date = competitionKstDate(start);
  fixture.run.started_at = new Date(start).toISOString();
  fixture.run.finished_at = new Date(finished).toISOString();
  fixture.sources[0].checked_at = new Date(start + 60_000).toISOString();
  if (fixture.candidates[0]) {
    fixture.candidates[0].discovered_at = new Date(start + 60_000).toISOString();
    fixture.candidates[0].official_verified_at = new Date(start + 2 * 60_000).toISOString();
    fixture.candidates[0].deadline_at = new Date(finished + 3 * DAY_MS).toISOString();
  }
  if (fixture.applications[0]) {
    fixture.applications[0].updated_at = new Date(start + 4 * 60_000).toISOString();
  }
  if (fixture.approvals?.[0]) {
    fixture.approvals[0].requested_at = new Date(start + 4 * 60_000).toISOString();
    if (fixture.approvals[0].expires_at) {
      fixture.approvals[0].expires_at = new Date(start + 14 * 60_000).toISOString();
    }
  }
  return fixture;
}

function assertCompetitionNoStore(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

function competitionFixture() {
  const fixture = {
    version: 1,
    idempotency_key: 'competition-daily-2026-08-31-001',
    run: {
      id: 'competition-2026-08-31-001',
      date: '2026-08-31',
      started_at: '2026-08-31T00:00:00+09:00',
      finished_at: '2026-08-31T00:05:00+09:00',
      status: 'complete',
      source_coverage: { expected: 1, checked: 1, succeeded: 1 },
    },
    sources: [{
      id: 'contest-listing',
      kind: 'listing',
      name: 'Contest Listing',
      reference_url: 'https://list.example/contests/123',
      checked_at: '2026-08-31T00:01:00+09:00',
      status: 'ok',
      failure_code: 'none',
      manual_check: false,
      candidate_count: 1,
    }],
    candidates: [{
      contest_id: 'organizer-2026-image',
      category: 'image',
      title: 'Example Image Contest',
      organizer: 'Example Organizer',
      source_id: 'contest-listing',
      discovery_url: 'https://list.example/contests/123',
      discovered_at: '2026-08-31T00:01:00+09:00',
      recency: 'new',
      official_url: 'https://organizer.example/rules',
      official_verification: 'verified',
      official_verified_at: '2026-08-31T00:02:00+09:00',
      acceptance: 'open',
      deadline_at: '2026-09-03T14:59:00Z',
      eligibility: 'eligible',
      fee_status: 'free',
      participation_mode: 'none',
      rights_risk: 'low',
      submission_risk: 'low',
      status: 'active',
      fit_score: 80,
      effort_score: 20,
    }],
    applications: [{
      contest_id: 'organizer-2026-image',
      category: 'image',
      profile_id: COMPETITION_PROFILE_ID,
      state: 'WAITING_ARTIFACTS',
      blocker: 'artifacts',
      next_action: 'prepare_artifacts',
      updated_at: '2026-08-31T00:04:00+09:00',
    }],
  };
  const currentKstDate = competitionKstDate(Date.now());
  const currentKstMidnight = Date.parse(`${currentKstDate}T00:00:00+09:00`);
  return setCompetitionTimeline(fixture, Math.max(currentKstMidnight, Date.now() - 10 * 60_000));
}

function competitionRequest(env, { method = 'POST', token = 'competition-token', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request('https://api.test/api/competitions/report', {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

function competitionWithPreparationApproval() {
  const fixture = competitionFixture();
  fixture.applications[0].state = 'WAITING_RIGHTS_APPROVAL';
  fixture.applications[0].blocker = 'rights';
  fixture.applications[0].next_action = 'review_rights';
  fixture.approvals = [{
    request_id: 'competition-preparation-organizer-2026-image',
    contest_id: fixture.candidates[0].contest_id,
    category: fixture.candidates[0].category,
    kind: 'preparation',
    action_sha256: 'a'.repeat(64),
    requested_at: fixture.applications[0].updated_at,
    expires_at: null,
    read_summary: '권리 이용 범위가 넓습니다. 공식 공고와 마감, 자격, 제출 규격을 확인했습니다.',
    approval_text: '작품 초안과 비식별 서류 준비만 허용합니다. 개인정보, 서명, 동의, 전송은 포함하지 않습니다.',
  }];
  return fixture;
}

function competitionApprovalRequest(env, {
  requestId = 'competition-preparation-organizer-2026-image',
  token = 'owner-token',
  body = { decision: 'approved', action_sha256: 'a'.repeat(64) },
} = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return worker.fetch(new Request(
    `https://api.test/api/competitions/approvals/${requestId}/decision`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  ), env);
}

async function competitionTestContext(t) {
  const context = await competitionDatabaseContext(t);
  if (!context) return null;
  context.env.COMPETITION_INGEST_TOKEN = 'competition-token';
  return context;
}

test('competition routes fail closed at the owner and dedicated-ingest-token boundaries', async () => {
  const noDatabase = {
    prepare() { throw new Error('competition authentication boundary reached the database'); },
  };
  for (const token of ['', 'wrong-token']) {
    const response = await competitionRequest({
      ALLOWED_ORIGIN: 'https://example.test',
      COMPETITION_INGEST_TOKEN: 'competition-token',
      DB: noDatabase,
    }, { token, body: competitionFixture() });
    assert.equal(response.status, 401);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: '인증이 필요합니다.' });
  }
  const unrelatedToken = await competitionRequest({
    ALLOWED_ORIGIN: 'https://example.test',
    COMPETITION_INGEST_TOKEN: '',
    BEHAVIOR_PAPER_REPORT_TOKEN: 'competition-token',
    DB: noDatabase,
  }, { body: competitionFixture() });
  assert.equal(unrelatedToken.status, 401);
  assertCompetitionNoStore(unrelatedToken);

  const anonymous = await worker.fetch(new Request('https://api.test/api/competitions'), {
    ALLOWED_ORIGIN: 'https://example.test',
  });
  assert.equal(anonymous.status, 401);
  assertCompetitionNoStore(anonymous);
  assert.deepEqual(await anonymous.json(), { error: '로그인이 필요합니다.' });

  const nonOwnerDb = {
    prepare(sql) {
      if (sql.includes('SELECT s.*, u.username')) {
        return {
          bind() {
            return {
              async first() {
                return { token_hash: 'student-hash', role: 'user', disabled: 0, username: 'student' };
              },
            };
          },
        };
      }
      if (sql.includes('UPDATE sessions')) {
        return { bind() { return { async run() { return { success: true }; } }; } };
      }
      throw new Error('non-owner reached competition data');
    },
  };
  const nonOwner = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer student-token' },
  }), {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: nonOwnerDb,
  });
  assert.equal(nonOwner.status, 404);
  assertCompetitionNoStore(nonOwner);
  assert.deepEqual(await nonOwner.json(), { error: 'Not found' });
});

test('checked-in reporter fixture is accepted by the Worker competition contract', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const fixture = setCompetitionTimeline(
    structuredClone(COMPETITION_REPORTER_FIXTURE),
    Math.max(
      Date.parse(`${competitionKstDate(Date.now())}T00:00:00+09:00`),
      Date.now() - 10 * 60_000,
    ),
  );
  const response = await competitionRequest(context.env, { body: fixture });
  assert.equal(response.status, 201);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: true,
    version: 1,
    idempotency_key: fixture.idempotency_key,
    run_id: fixture.run.id,
    replayed: false,
    counts: { sources: 1, candidates: 1, applications: 1 },
  });
});

test('competition report round-trips through normalized SQLite and exact replay adds no rows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionFixture();
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);
  assert.deepEqual(await created.json(), {
    ok: true,
    version: 1,
    idempotency_key: fixture.idempotency_key,
    run_id: fixture.run.id,
    replayed: false,
    counts: { sources: 1, candidates: 1, applications: 1 },
  });

  const replay = await competitionRequest(env, { body: structuredClone(fixture) });
  assert.equal(replay.status, 200);
  assertCompetitionNoStore(replay);
  assert.equal((await replay.json()).replayed, true);
  for (const table of [
    'competition_reports', 'competition_sources', 'competition_candidates',
    'competition_applications',
  ]) {
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 1);
  }

  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.deepEqual(Object.keys(body), ['summary', 'runs', 'sources', 'candidates', 'applications']);
  assert.deepEqual(body.summary, {
    latest_scan_at: fixture.run.finished_at,
    partial: false,
    today: {
      discovered: 1,
      verified: 1,
      ready: 1,
      awaiting_approval: 0,
      deadline_soon: 1,
    },
  });
  assert.deepEqual(body.runs, [{
    id: fixture.run.id,
    date: fixture.run.date,
    started_at: fixture.run.started_at,
    finished_at: fixture.run.finished_at,
    status: 'complete',
    source_coverage: { expected: 1, checked: 1, succeeded: 1 },
  }]);
  assert.deepEqual(body.sources, [{
    id: 'contest-listing',
    kind: 'listing',
    name: 'Contest Listing',
    reference_url: 'https://list.example/contests/123',
    status: 'ok',
    checked_at: fixture.sources[0].checked_at,
    candidate_count: 1,
    failure_code: 'none',
    manual_check: false,
  }]);
  assert.deepEqual(body.candidates, [{
    contest_id: 'organizer-2026-image',
    category: 'image',
    title: 'Example Image Contest',
    organizer: 'Example Organizer',
    source_id: 'contest-listing',
    discovery_url: 'https://list.example/contests/123',
    discovered_at: fixture.candidates[0].discovered_at,
    recency: 'new',
    official_url: 'https://organizer.example/rules',
    official_verification: 'verified',
    official_verified_at: fixture.candidates[0].official_verified_at,
    acceptance: 'open',
    deadline_at: fixture.candidates[0].deadline_at,
    eligibility: 'eligible',
    fee_status: 'free',
    participation_mode: 'none',
    status: 'active',
    rights_risk: 'low',
    submission_risk: 'low',
    fit_score: 80,
    effort_score: 20,
  }]);
  assert.deepEqual(body.applications, [{
    contest_id: 'organizer-2026-image',
    category: 'image',
    state: 'WAITING_ARTIFACTS',
    updated_at: fixture.applications[0].updated_at,
    blocker: 'artifacts',
    next_action: 'prepare_artifacts',
    approval: null,
  }]);
  assert.throws(
    () => database.prepare("UPDATE competition_reports SET run_status = 'failed'").run(),
    /immutable/u,
  );
});

test('competition web approval is owner-only, action-bound, idempotent and durable', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionWithPreparationApproval();
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);

  const before = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(before.status, 200);
  const beforeBody = await before.json();
  assert.equal(beforeBody.summary.today.awaiting_approval, 1);
  assert.deepEqual(beforeBody.applications[0].approval, {
    request_id: fixture.approvals[0].request_id,
    kind: 'preparation',
    action_sha256: 'a'.repeat(64),
    requested_at: fixture.approvals[0].requested_at,
    expires_at: null,
    read_summary: fixture.approvals[0].read_summary,
    approval_text: fixture.approvals[0].approval_text,
    status: 'pending',
    decided_at: null,
  });

  const anonymous = await competitionApprovalRequest(env, { token: '' });
  assert.equal(anonymous.status, 401);
  assertCompetitionNoStore(anonymous);
  const nonOwner = await competitionApprovalRequest(env, { token: 'student-token' });
  assert.equal(nonOwner.status, 404);
  assertCompetitionNoStore(nonOwner);

  const stale = await competitionApprovalRequest(env, {
    body: { decision: 'approved', action_sha256: 'b'.repeat(64) },
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'approval_stale' });

  const approved = await competitionApprovalRequest(env);
  assert.equal(approved.status, 201);
  assertCompetitionNoStore(approved);
  assert.equal((await approved.json()).replayed, false);
  const replay = await competitionApprovalRequest(env);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const conflict = await competitionApprovalRequest(env, {
    body: { decision: 'held', action_sha256: 'a'.repeat(64) },
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'approval_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 1);

  const after = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(after.status, 200);
  const afterBody = await after.json();
  assert.equal(afterBody.summary.today.awaiting_approval, 0);
  assert.equal(afterBody.applications[0].approval.status, 'approved');
  assert.ok(afterBody.applications[0].approval.decided_at);
});

test('competition runtime fails closed for legacy unknown preferences and expired deadlines', async (t) => {
  const legacyContext = await competitionTestContext(t);
  if (!legacyContext) return;
  const legacy = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(legacyContext.env, { body: legacy })).status, 201);

  // Simulate an active row written before 0018: ALTER TABLE supplies unknown while the old row
  // retains its legacy active/application/approval state.
  legacyContext.database.exec('DROP TRIGGER competition_candidates_no_update');
  legacyContext.database.prepare(`
    UPDATE competition_candidates SET fee_status = 'unknown'
    WHERE idempotency_key = ? AND contest_id = ? AND category = ?
  `).run(legacy.idempotency_key, legacy.candidates[0].contest_id, legacy.candidates[0].category);

  const lookup = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), legacyContext.env);
  assert.equal(lookup.status, 200);
  const payload = await lookup.json();
  assert.equal(payload.candidates[0].status, 'deferred');
  assert.equal(payload.applications[0].state, 'WAITING_CLARIFICATION');
  assert.equal(payload.applications[0].approval, null);
  assert.equal(payload.summary.today.ready, 0);
  assert.equal(payload.summary.today.awaiting_approval, 0);
  const staleDecision = await competitionApprovalRequest(legacyContext.env);
  assert.equal(staleDecision.status, 409);
  assert.deepEqual(await staleDecision.json(), { error: 'approval_stale' });
  assert.equal(Number(legacyContext.database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 0);

  const deadlineContext = await competitionTestContext(t);
  if (!deadlineContext) return;
  const expired = competitionWithPreparationApproval();
  expired.idempotency_key = 'competition-action-deadline-expired';
  expired.run.id = expired.idempotency_key;
  expired.candidates[0].deadline_at = new Date(Date.now() - 1_000).toISOString();
  assert.ok(Date.parse(expired.candidates[0].deadline_at) > Date.parse(expired.run.finished_at));
  assert.equal((await competitionRequest(deadlineContext.env, { body: expired })).status, 201);
  const expiredDecision = await competitionApprovalRequest(deadlineContext.env);
  assert.equal(expiredDecision.status, 409);
  assert.deepEqual(await expiredDecision.json(), { error: 'approval_stale' });
});

test('competition database rejects paid and offline active candidates before application insertion', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const fixture = competitionFixture();
  fixture.applications = [];
  assert.equal((await competitionRequest(context.env, { body: fixture })).status, 201);
  const insert = context.database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, fee_status,
      participation_mode, rights_risk, submission_risk, status, fit_score, effort_score
    ) VALUES (?, ?, 'image', 'Preference probe', 'Example Organizer', 'contest-listing',
      'https://list.example/contests/probe', ?, 'new', 'https://organizer.example/rules/probe',
      'verified', ?, 'open', ?, 'eligible', ?, ?, 'low', 'low', 'active', 80, 20)
  `);
  for (const [id, feeStatus, participationMode] of [
    ['paid-active', 'paid', 'none'],
    ['offline-active', 'free', 'offline_required'],
  ]) {
    assert.throws(() => insert.run(
      fixture.idempotency_key,
      id,
      fixture.candidates[0].discovered_at,
      fixture.candidates[0].official_verified_at,
      fixture.candidates[0].deadline_at,
      feeStatus,
      participationMode,
    ), /active competition requires free remote-compatible participation/u);
  }
});

test('competition approval survives a newer snapshot while raw state regression and request rebinding fail', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const approved = await competitionApprovalRequest(env);
  assert.equal(approved.status, 201);

  const carried = structuredClone(first);
  carried.idempotency_key = 'competition-carried-approval-request';
  carried.run.id = 'competition-carried-approval-request';
  carried.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  assert.equal((await competitionRequest(env, { body: carried })).status, 201);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 1, 'one immutable action is reused');
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_report_approval_requests',
  ).get().count), 2, 'both immutable reports link the same action');
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assert.equal((await looked.json()).applications[0].approval.status, 'approved');

  const newer = competitionFixture();
  setCompetitionTimeline(newer, Date.parse(carried.run.started_at) + 2_000);
  newer.idempotency_key = 'competition-newer-without-old-approval';
  newer.run.id = 'competition-newer-without-old-approval';
  const regression = await competitionRequest(env, { body: newer });
  assert.equal(regression.status, 409);
  assert.deepEqual(await regression.json(), { error: 'report_state_regression' });

  const rebound = competitionWithPreparationApproval();
  setCompetitionTimeline(rebound, Date.parse(carried.run.started_at) + 3_000);
  rebound.idempotency_key = 'competition-rebound-approval-request';
  rebound.run.id = 'competition-rebound-approval-request';
  rebound.approvals[0].action_sha256 = 'b'.repeat(64);
  const collision = await competitionRequest(env, { body: rebound });
  assert.equal(collision.status, 409);
  assert.deepEqual(await collision.json(), { error: 'approval_request_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'only the original and safely carried snapshots exist');
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 1);

  const reworded = structuredClone(carried);
  reworded.idempotency_key = 'competition-reworded-approval-request';
  reworded.run.id = 'competition-reworded-approval-request';
  reworded.run.finished_at = new Date(Date.parse(carried.run.finished_at) + 4_000).toISOString();
  reworded.approvals[0].approval_text += ' 변경된 문구';
  const wordingCollision = await competitionRequest(env, { body: reworded });
  assert.equal(wordingCollision.status, 409);
  assert.deepEqual(await wordingCollision.json(), { error: 'approval_request_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'the same request id cannot be rebound by changing only its wording');
});

test('competition approval transitions preserve exact decisions without freezing later workflow', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const replacement = structuredClone(first);
  setCompetitionTimeline(replacement, Date.parse(first.run.started_at) + 10_000);
  replacement.idempotency_key = 'competition-replacement-approval-request';
  replacement.run.id = 'competition-replacement-approval-request';
  replacement.approvals[0].request_id = 'competition-preparation-organizer-2026-image-v2';
  replacement.approvals[0].action_sha256 = 'c'.repeat(64);
  replacement.approvals[0].approval_text += ' 새 조건을 다시 확인합니다.';
  assert.equal((await competitionRequest(env, { body: replacement })).status, 201);
  let looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  let body = await looked.json();
  assert.equal(body.applications[0].approval.request_id, replacement.approvals[0].request_id);
  assert.equal(body.applications[0].approval.status, 'pending', 'changed action never reuses a decision');

  const approved = await competitionApprovalRequest(env, {
    requestId: replacement.approvals[0].request_id,
    body: { decision: 'approved', action_sha256: 'c'.repeat(64) },
  });
  assert.equal(approved.status, 201);

  const unauthorized = structuredClone(replacement);
  setCompetitionTimeline(unauthorized, Date.parse(replacement.run.started_at) + 10_000);
  unauthorized.idempotency_key = 'competition-preparation-cannot-authorize-submission';
  unauthorized.run.id = 'competition-preparation-cannot-authorize-submission';
  unauthorized.applications[0].state = 'AUTHORIZED';
  unauthorized.applications[0].blocker = 'none';
  unauthorized.applications[0].next_action = 'none';
  unauthorized.approvals = [];
  const unauthorizedResponse = await competitionRequest(env, { body: unauthorized });
  assert.equal(unauthorizedResponse.status, 409);
  assert.deepEqual(await unauthorizedResponse.json(), { error: 'report_state_regression' });

  const premature = structuredClone(replacement);
  setCompetitionTimeline(premature, Date.parse(replacement.run.started_at) + 10_000);
  premature.idempotency_key = 'competition-approved-preparation-predated';
  premature.run.id = 'competition-approved-preparation-predated';
  premature.applications[0].state = 'PREPARED';
  premature.applications[0].blocker = 'none';
  premature.applications[0].next_action = 'draft_application';
  premature.approvals = [];
  const prematureResponse = await competitionRequest(env, { body: premature });
  assert.equal(prematureResponse.status, 409);
  assert.deepEqual(await prematureResponse.json(), { error: 'report_state_regression' });

  const progressed = structuredClone(replacement);
  setCompetitionTimeline(progressed, Date.now());
  progressed.idempotency_key = 'competition-approved-preparation-progressed';
  progressed.run.id = 'competition-approved-preparation-progressed';
  progressed.applications[0].state = 'PREPARED';
  progressed.applications[0].blocker = 'none';
  progressed.applications[0].next_action = 'draft_application';
  progressed.approvals = [];
  assert.equal((await competitionRequest(env, { body: progressed })).status, 201);
  looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  body = await looked.json();
  assert.equal(body.applications[0].state, 'PREPARED');
  assert.equal(body.applications[0].approval, null);

  const heldContext = await competitionTestContext(t);
  if (!heldContext) return;
  const heldFirst = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(heldContext.env, { body: heldFirst })).status, 201);
  assert.equal((await competitionApprovalRequest(heldContext.env, {
    body: { decision: 'held', action_sha256: 'a'.repeat(64) },
  })).status, 201);
  const bypass = structuredClone(heldFirst);
  setCompetitionTimeline(bypass, Date.parse(heldFirst.run.started_at) + 10_000);
  bypass.idempotency_key = 'competition-held-preparation-bypass';
  bypass.run.id = 'competition-held-preparation-bypass';
  bypass.applications[0].state = 'PREPARED';
  bypass.applications[0].blocker = 'none';
  bypass.applications[0].next_action = 'draft_application';
  bypass.approvals = [];
  const rejected = await competitionRequest(heldContext.env, { body: bypass });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'report_state_regression' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 3);
});

test('competition report guard rejects a same-time official fact rewrite atomically', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const rewritten = structuredClone(first);
  rewritten.idempotency_key = 'competition-same-time-official-rewrite';
  rewritten.run.id = 'competition-same-time-official-rewrite';
  rewritten.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  rewritten.candidates[0].organizer = 'Rewritten Organizer';
  const response = await competitionRequest(env, { body: rewritten });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_report_guards',
  ).get().count), 1);
});

test('competition report drops an application only after a newer official closure check', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const closed = structuredClone(first);
  setCompetitionTimeline(closed, Date.parse(first.run.started_at) + 10_000);
  closed.idempotency_key = 'competition-officially-closed';
  closed.run.id = 'competition-officially-closed';
  closed.candidates[0].acceptance = 'closed';
  closed.candidates[0].deadline_at = closed.run.finished_at;
  closed.candidates[0].status = 'rejected';
  closed.applications = [];

  const response = await competitionRequest(env, { body: closed });
  assert.equal(response.status, 201);
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM competition_applications WHERE idempotency_key = 'competition-officially-closed'",
  ).get().count), 0);
});

test('competition report drops an application after a newer official deadline expiry check', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const expired = structuredClone(first);
  setCompetitionTimeline(expired, Date.parse(first.run.started_at) + 10_000);
  expired.idempotency_key = 'competition-officially-expired';
  expired.run.id = 'competition-officially-expired';
  expired.candidates[0].acceptance = 'open';
  expired.candidates[0].deadline_at = expired.run.finished_at;
  expired.candidates[0].status = 'rejected';
  expired.applications = [];

  assert.equal((await competitionRequest(env, { body: expired })).status, 201);
});

test('competition report rejects application removal without an explicit rejected terminal state', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const nonterminal = structuredClone(first);
  setCompetitionTimeline(nonterminal, Date.parse(first.run.started_at) + 10_000);
  nonterminal.idempotency_key = 'competition-closed-but-nonterminal';
  nonterminal.run.id = 'competition-closed-but-nonterminal';
  nonterminal.candidates[0].acceptance = 'closed';
  nonterminal.candidates[0].status = 'verifying';
  nonterminal.applications = [];

  const response = await competitionRequest(env, { body: nonterminal });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
});

test('competition report rejects application removal one second before deadline', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const early = structuredClone(first);
  setCompetitionTimeline(early, Date.parse(first.run.started_at) + 10_000);
  early.idempotency_key = 'competition-deadline-not-yet-reached';
  early.run.id = 'competition-deadline-not-yet-reached';
  early.candidates[0].acceptance = 'open';
  early.candidates[0].deadline_at = new Date(Date.parse(early.run.finished_at) + 1_000).toISOString();
  early.candidates[0].status = 'rejected';
  early.applications = [];

  const response = await competitionRequest(env, { body: early });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
});

test('competition report cannot use another closed contest to drop an open application', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const first = competitionFixture();
  first.sources[0].candidate_count = 2;
  first.candidates.push({
    ...structuredClone(first.candidates[0]),
    contest_id: 'organizer-2026-writing',
    category: 'writing',
    title: 'Example Writing Contest',
    official_url: 'https://organizer.example/writing-rules',
  });
  first.applications.push({
    ...structuredClone(first.applications[0]),
    contest_id: 'organizer-2026-writing',
    category: 'writing',
  });
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const mixed = structuredClone(first);
  setCompetitionTimeline(mixed, Date.parse(first.run.started_at) + 10_000);
  mixed.idempotency_key = 'competition-cross-contest-closure';
  mixed.run.id = 'competition-cross-contest-closure';
  mixed.candidates[0].acceptance = 'closed';
  mixed.candidates[0].status = 'rejected';
  mixed.applications = [];

  const response = await competitionRequest(env, { body: mixed });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
});

test('competition report retires an obsolete approval link after official closure', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const closed = structuredClone(first);
  setCompetitionTimeline(closed, Date.parse(first.run.started_at) + 10_000);
  closed.idempotency_key = 'competition-closed-with-obsolete-approval';
  closed.run.id = 'competition-closed-with-obsolete-approval';
  closed.candidates[0].acceptance = 'closed';
  closed.candidates[0].status = 'rejected';
  closed.applications = [];
  closed.approvals = [];

  assert.equal((await competitionRequest(env, { body: closed })).status, 201);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 1, 'the immutable origin request remains auditable');
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM competition_report_approval_requests WHERE idempotency_key = 'competition-closed-with-obsolete-approval'",
  ).get().count), 0, 'the obsolete request is absent from the latest snapshot');
});

test('competition report still rejects silently dropping an open application', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const omitted = structuredClone(first);
  setCompetitionTimeline(omitted, Date.parse(first.run.started_at) + 10_000);
  omitted.idempotency_key = 'competition-open-application-omitted';
  omitted.run.id = 'competition-open-application-omitted';
  omitted.applications = [];

  const response = await competitionRequest(env, { body: omitted });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM competition_reports WHERE idempotency_key = 'competition-open-application-omitted'",
  ).get().count), 0);
});

test('competition report guard rolls back a writer whose expected prior changed', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const winner = structuredClone(first);
  winner.idempotency_key = 'competition-concurrent-winner';
  winner.run.id = 'competition-concurrent-winner';
  winner.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  const loser = structuredClone(first);
  loser.idempotency_key = 'competition-concurrent-loser';
  loser.run.id = 'competition-concurrent-loser';
  loser.run.finished_at = new Date(Date.parse(first.run.finished_at) + 2_000).toISOString();

  let injected = false;
  const racingEnv = {
    ...env,
    DB: {
      prepare(sql) { return env.DB.prepare(sql); },
      async batch(statements) {
        if (!injected) {
          injected = true;
          const winningResponse = await competitionRequest(env, { body: winner });
          assert.equal(winningResponse.status, 201);
        }
        return env.DB.batch(statements);
      },
    },
  };
  const response = await competitionRequest(racingEnv, { body: loser });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_concurrent_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'the stale writer batch is fully rolled back');
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM competition_reports WHERE idempotency_key = 'competition-concurrent-loser'",
  ).get().count), 0);
});

test('competition approval expiry is checked by the same SQLite clock that stores the decision', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionWithPreparationApproval();
  fixture.idempotency_key = 'competition-expiry-at-write';
  fixture.run.id = 'competition-expiry-at-write';
  fixture.applications[0].state = 'WAITING_APPROVAL';
  fixture.applications[0].blocker = 'user_approval';
  fixture.applications[0].next_action = 'request_approval';
  fixture.approvals[0].kind = 'final_submission';
  fixture.approvals[0].expires_at = new Date(Date.now() + 500).toISOString();
  assert.equal((await competitionRequest(env, { body: fixture })).status, 201);

  const delayedDb = {
    ...env.DB,
    prepare(sql) {
      const prepared = env.DB.prepare(sql);
      if (!sql.includes('INSERT INTO competition_approval_decisions')) return prepared;
      const delayRun = (statement) => ({
        bind(...values) { return delayRun(statement.bind(...values)); },
        first() { return statement.first(); },
        all() { return statement.all(); },
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 650));
          return statement.run();
        },
      });
      return delayRun(prepared);
    },
  };
  const expired = await competitionApprovalRequest({ ...env, DB: delayedDb });
  assert.equal(expired.status, 409);
  assert.deepEqual(await expired.json(), { error: 'approval_expired' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 0);
});

test('competition approval report rejects state mismatch and stale sensitive windows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;

  const mismatched = competitionWithPreparationApproval();
  mismatched.idempotency_key = 'competition-approval-state-mismatch';
  mismatched.run.id = 'competition-approval-state-mismatch';
  mismatched.applications[0].state = 'WAITING_ARTIFACTS';
  const mismatchResponse = await competitionRequest(env, { body: mismatched });
  assert.equal(mismatchResponse.status, 400);

  const expired = competitionWithPreparationApproval();
  expired.idempotency_key = 'competition-expired-final-approval';
  expired.run.id = 'competition-expired-final-approval';
  expired.applications[0].state = 'WAITING_APPROVAL';
  expired.applications[0].blocker = 'user_approval';
  expired.applications[0].next_action = 'request_approval';
  expired.approvals[0].kind = 'final_submission';
  expired.approvals[0].requested_at = new Date(
    Date.parse(expired.run.finished_at) - 10 * 60_000,
  ).toISOString();
  expired.approvals[0].expires_at = new Date(
    Date.parse(expired.run.finished_at) - 60_000,
  ).toISOString();
  const expiredResponse = await competitionRequest(env, { body: expired });
  assert.equal(expiredResponse.status, 400);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 0);
});

test('competition idempotency binds the key to one payload and concurrent conflict cannot mix children', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const left = competitionFixture();
  const right = structuredClone(left);
  right.candidates[0].title = 'Different Contest Title';
  const responses = await Promise.all([
    competitionRequest(env, { body: left }),
    competitionRequest(env, { body: right }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const conflict = responses.find((response) => response.status === 409);
  assertCompetitionNoStore(conflict);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_candidates').get().count), 1);
  const storedTitle = database.prepare('SELECT title FROM competition_candidates').get().title;
  assert.ok(['Example Image Contest', 'Different Contest Title'].includes(storedTitle));
  const storedHash = database.prepare('SELECT payload_hash FROM competition_reports').get().payload_hash;
  assert.match(storedHash, /^[a-f0-9]{64}$/u);
});

test('competition idempotency preserves raw field values across storage normalization', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const first = competitionFixture();
  first.idempotency_key = 'competition-raw-value-idempotency';
  first.run.id = 'competition-raw-value-idempotency';
  first.candidates[0].title = 'Example  Image Contest';
  const second = structuredClone(first);
  second.candidates[0].title = 'Example Image Contest';

  const created = await competitionRequest(context.env, { body: first });
  assert.equal(created.status, 201);
  const conflict = await competitionRequest(context.env, { body: second });
  assert.equal(conflict.status, 409);
  assertCompetitionNoStore(conflict);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
});

test('competition cross-object trust probes fail closed without writing any report rows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['expired-active', (body) => {
      body.candidates[0].deadline_at = body.run.finished_at;
    }],
    ['timeout-closed', (body) => {
      body.run.status = 'partial';
      body.run.source_coverage.succeeded = 0;
      body.sources[0].status = 'partial';
      body.sources[0].failure_code = 'timeout';
      body.sources[0].manual_check = true;
      body.candidates[0].status = 'rejected';
      body.candidates[0].acceptance = 'closed';
      body.applications = [];
    }],
    ['no-results-with-candidate', (body) => {
      body.sources[0].status = 'no_results';
    }],
    ['rejected-with-application', (body) => {
      body.candidates[0].status = 'rejected';
    }],
    ['verified-placeholder-organizer', (body) => {
      body.candidates[0].organizer = '주최 기관 - 공식 확인 필요';
    }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-probe-${name}`;
    body.run.id = `competition-probe-${name}`;
    mutate(body);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: 'invalid_report' }, name);
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
      0,
      name,
    );
  }
});

test('competition identifier slots reject private contact values without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['idempotency', (body) => { body.idempotency_key = '01012345678'; }],
    ['run', (body) => { body.run.id = '0212345678'; }],
    ['source', (body) => {
      body.sources[0].id = '01012345678';
      body.candidates[0].source_id = '01012345678';
    }],
    ['contest', (body) => {
      body.candidates[0].contest_id = '01012345678';
      body.applications[0].contest_id = '01012345678';
    }],
    ['category', (body) => {
      body.candidates[0].category = '0212345678';
      body.applications[0].category = '0212345678';
    }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-private-id-${name}`;
    body.run.id = `competition-private-id-${name}`;
    mutate(body);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
  }
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition ingest rejects its exact active secret anywhere in the payload', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const body = competitionFixture();
  body.idempotency_key = 'competition-active-secret-payload';
  body.run.id = body.idempotency_key;
  body.candidates[0].organizer = env.COMPETITION_INGEST_TOKEN;
  const response = await competitionRequest(env, {
    body,
    token: env.COMPETITION_INGEST_TOKEN,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_data' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition ingest rejects its fully percent-encoded active secret without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  env.COMPETITION_INGEST_TOKEN = 'opaque-active-ingest-value-123456789';
  const encodedToken = [...Buffer.from(env.COMPETITION_INGEST_TOKEN, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  const body = competitionFixture();
  body.idempotency_key = 'competition-encoded-active-secret';
  body.run.id = body.idempotency_key;
  body.candidates[0].official_url = `https://organizer.example/${encodedToken}/rules`;
  const response = await competitionRequest(env, {
    body,
    token: env.COMPETITION_INGEST_TOKEN,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_data' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition capacity migration preserves immutable rows, constraints, and indexes', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('./migrations/0014_competitions.sql', import.meta.url), 'utf8'));
  database.prepare(`
    INSERT INTO competition_reports(
      idempotency_key, payload_hash, schema_version, received_at, run_id, run_date,
      run_status, started_at, finished_at, coverage_expected, coverage_checked,
      coverage_succeeded, source_count, candidate_count, application_count
    ) VALUES (?, ?, 1, ?, ?, ?, 'complete', ?, ?, 1, 1, 1, 1, 1, 0)
  `).run(
    'capacity-existing', 'a'.repeat(64), '2026-08-31T00:02:00.000Z',
    'capacity-existing', '2026-08-31', '2026-08-31T00:00:00.000Z',
    '2026-08-31T00:01:00.000Z',
  );
  database.prepare(`
    INSERT INTO competition_sources(
      idempotency_key, source_id, kind, name, reference_url, checked_at,
      status, failure_code, manual_check, candidate_count
    ) VALUES ('capacity-existing', 'source', 'listing', 'Source',
      'https://list.example/contests', '2026-08-31T00:00:30.000Z',
      'ok', 'none', 0, 1)
  `).run();
  database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, rights_risk,
      submission_risk, status, fit_score, effort_score
    ) VALUES ('capacity-existing', 'contest', 'idea', 'Existing Contest', 'Organizer',
      'source', 'https://list.example/contests/1', '2026-08-31T00:00:30.000Z',
      'new', NULL, 'unverified', NULL, 'unknown', NULL, 'unknown', 'unknown',
      'unknown', 'verifying', 50, 50)
  `).run();

  database.exec(readFileSync(
    new URL('./migrations/0015_competition_candidate_capacity.sql', import.meta.url),
    'utf8',
  ));
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_sources',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_candidates',
  ).get().count), 1);
  const capacityTables = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('competition_reports', 'competition_sources')
  `).all();
  assert.equal(capacityTables.length, 2);
  assert.ok(capacityTables.every((entry) => (
    entry.sql.includes('candidate_count BETWEEN 0 AND 500')
  )));
  assert.throws(
    () => database.prepare("UPDATE competition_reports SET run_status = 'failed'").run(),
    /competition reports are immutable/u,
  );
});

test('competition accepts and exactly replays the full 500-candidate contract', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const body = competitionFixture();
  body.idempotency_key = 'competition-capacity-500';
  body.run.id = body.idempotency_key;
  body.sources[0].candidate_count = 500;
  body.applications = [];
  body.candidates = Array.from({ length: 500 }, (_, index) => ({
    ...body.candidates[0],
    contest_id: `capacity-contest-${index}`,
    title: `Capacity Contest ${index}`,
    official_url: null,
    official_verification: 'unverified',
    official_verified_at: null,
    acceptance: 'unknown',
    deadline_at: null,
    eligibility: 'unknown',
    rights_risk: 'unknown',
    submission_risk: 'unknown',
    status: 'verifying',
  }));
  const created = await competitionRequest(env, { body });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).counts, {
    sources: 1,
    candidates: 500,
    applications: 0,
  });
  const replay = await competitionRequest(env, { body: structuredClone(body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(Number(database.prepare(
    'SELECT candidate_count FROM competition_reports WHERE idempotency_key = ?',
  ).get(body.idempotency_key).candidate_count), 500);
  assert.equal(Number(database.prepare(
    'SELECT candidate_count FROM competition_sources WHERE idempotency_key = ?',
  ).get(body.idempotency_key).candidate_count), 500);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_candidates WHERE idempotency_key = ?',
  ).get(body.idempotency_key).count), 500);
});

test('competition migration rejects malformed timestamps in every normalized table', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database } = context;
  const canonical = '2026-08-31T00:00:00.000Z';
  const malformed = 'xxxx-xx-xxTxx:xx:xx.xxxZ';
  const reportInsert = database.prepare(`
    INSERT INTO competition_reports(
      idempotency_key, payload_hash, schema_version, received_at,
      run_id, run_date, run_status, started_at, finished_at,
      coverage_expected, coverage_checked, coverage_succeeded,
      source_count, candidate_count, application_count
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)
  `);
  const insertReport = ({
    key, receivedAt = canonical, runDate = '2026-08-31', startedAt = canonical,
    finishedAt = '2026-08-31T00:05:00.000Z', status = 'complete',
    candidateCount = 0, applicationCount = 0,
  }) => reportInsert.run(
    key, 'a'.repeat(64), receivedAt, key, runDate, status, startedAt, finishedAt,
    candidateCount, applicationCount,
  );
  const invalidReports = [
    { key: 'bad-received-at', receivedAt: malformed },
    { key: 'bad-received-hour', receivedAt: '2026-09-01T24:00:00.000Z' },
    { key: 'bad-run-date', runDate: 'xxxx-xx-xx' },
    { key: 'bad-started-at', startedAt: malformed },
    { key: 'bad-started-hour', startedAt: '2026-08-31T24:00:00.000Z' },
    { key: 'bad-finished-at', finishedAt: '2026-08-31T00:05:xx.xxxZ' },
    { key: 'bad-finished-hour', finishedAt: '2026-08-31T24:00:00.000Z' },
  ];
  for (const probe of invalidReports) {
    assert.throws(() => insertReport(probe), /CHECK constraint failed/u, probe.key);
  }

  insertReport({ key: 'timestamp-parent', candidateCount: 1, applicationCount: 1 });
  const sourceInsert = database.prepare(`
    INSERT INTO competition_sources(
      idempotency_key, source_id, kind, name, reference_url, checked_at,
      status, failure_code, manual_check, candidate_count
    ) VALUES ('timestamp-parent', ?, 'listing', 'Public listing',
      'https://public.example/contests', ?, 'ok', 'none', 0, 1)
  `);
  assert.throws(
    () => sourceInsert.run('bad-source-time', '2026-08-31T00:01:xx.xxxZ'),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => sourceInsert.run('bad-source-hour', '2026-08-30T24:01:00.000Z'),
    /CHECK constraint failed/u,
  );
  sourceInsert.run('timestamp-source', '2026-08-31T00:01:00.000Z');

  const candidateInsert = database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, fee_status,
      participation_mode, rights_risk, submission_risk, status, fit_score, effort_score
    ) VALUES ('timestamp-parent', ?, 'test', 'Public contest', 'Public organizer',
      'timestamp-source', 'https://public.example/contest', ?, 'new', ?, ?, ?, ?, ?, ?,
      'free', 'none', 'low', 'low', ?, 50, 50)
  `);
  const insertCandidate = ({
    id, discoveredAt = '2026-08-31T00:01:00.000Z', officialUrl = null,
    verification = 'unverified', verifiedAt = null, acceptance = 'unknown',
    deadlineAt = null, eligibility = 'unknown', status = 'discovered',
  }) => candidateInsert.run(
    id, discoveredAt, officialUrl, verification, verifiedAt, acceptance, deadlineAt,
    eligibility, status,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-discovered', discoveredAt: '2026-08-31T00:01:xx.xxxZ' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-discovered-hour', discoveredAt: '2026-08-30T24:01:00.000Z' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({
      id: 'bad-verified',
      officialUrl: 'https://official.example/rules',
      verification: 'verified',
      verifiedAt: '2026-08-31T00:02:xx.xxxZ',
    }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({
      id: 'bad-verified-hour',
      discoveredAt: '2026-08-30T23:00:00.000Z',
      officialUrl: 'https://official.example/rules',
      verification: 'verified',
      verifiedAt: '2026-08-30T24:01:00.000Z',
    }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-deadline', deadlineAt: '2026-09-03T14:59:xx.xxxZ' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-deadline-hour', deadlineAt: '2026-09-03T24:00:00.000Z' }),
    /CHECK constraint failed/u,
  );
  insertCandidate({
    id: 'timestamp-candidate',
    discoveredAt: '2026-08-30T23:00:00.000Z',
    officialUrl: 'https://official.example/rules',
    verification: 'verified',
    verifiedAt: '2026-08-30T23:30:00.000Z',
    acceptance: 'open',
    deadlineAt: '2026-09-03T14:59:00.000Z',
    eligibility: 'eligible',
    status: 'active',
  });

  assert.throws(() => database.prepare(`
    INSERT INTO competition_applications(
      idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
    ) VALUES ('timestamp-parent', 'timestamp-candidate', 'test', ?,
      'WAITING_ARTIFACTS', 'artifacts', 'prepare_artifacts', '2026-08-31T00:04:xx.xxxZ')
  `).run(COMPETITION_PROFILE_ID), /CHECK constraint failed/u);
  assert.throws(() => database.prepare(`
    INSERT INTO competition_applications(
      idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
    ) VALUES ('timestamp-parent', 'timestamp-candidate', 'test', ?,
      'WAITING_ARTIFACTS', 'artifacts', 'prepare_artifacts', '2026-08-30T24:01:00.000Z')
  `).run(COMPETITION_PROFILE_ID), /CHECK constraint failed/u);
});

test('competition URLs reject decoded PII, private-token aliases, and trailing-dot local hosts', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const unsafeUrls = [
    'https://public.example/person@example.com/rules',
    'https://public.example/person%40example.com/rules',
    'https://public.example/person%2540example.com/rules',
    'https://public.example/010-1234-5678/rules',
    'https://public.example/%30%31%30%2D%31%32%33%34%2D%35%36%37%38/rules',
    'https://public.example/01012345678/rules',
    'https://public.example/%30%31%30%31%32%33%34%35%36%37%38/rules',
    'https://public.example/0212345678/rules',
    'https://public.example/rules?email=person@example.com',
    'https://public.example/rules?person=person%2540example.com',
    'https://public.example/rules?access_token=privatevalue123',
    'https://public.example/rules?access%255Ftoken=privatevalue123',
    'https://public.example/rules?client_secret=privatevalue123',
    'https://public.example/rules?client-secret=privatevalue123',
    'https://public.example/rules?clientSecret=privatevalue123',
    'https://public.example/rules?client.secret=privatevalue123',
    'https://public.example/rules?CLIENT%255FSECRET=privatevalue123',
    'https://public.example/rules?refresh_token=privatevalue123',
    'https://public.example/rules?refreshToken=privatevalue123',
    'https://public.example/rules?authorization=privatevalue123',
    'https://public.example/rules?signature=privatevalue123',
    'https://public.example/private_key=privatevalue123/rules',
    'https://public.example/rules?auth_token=privatevalue123',
    'https://public.example/rules?session_id=privatevalue123',
    'https://public.example/rules?oauthCode=privatevalue123',
    'https://public.example/rules?x-amz-signature=privatevalue123',
    'https://public.example/access_token/privatevalue123/rules',
    'https://public.example/access%255Ftoken%252Fprivatevalue123/rules',
    'https://public.example/clientSecret/privatevalue123/rules',
    'https://public.example/client%255Fsecret%252Fprivatevalue123/rules',
    'https://public.example/authToken/privatevalue123/rules',
    'https://public.example/x-amz-signature/privatevalue123/rules',
    'https://public.example/(authorization=privatevalue123)/rules',
    'https://public.example/[client_secret=privatevalue123]/rules',
    'https://public.example/,refresh_token=privatevalue123/rules',
    'https://public.example/%28authorization%3Dprivatevalue123%29/rules',
    'https://public.example/%22authorization%22=%22privatevalue123%22/rules',
    'https://public.example/proxy_authorization=privatevalue123/rules',
    'https://public.example/api%20key=privatevalue123/rules',
    'https://public.example/(authorization!=privatevalue123)/rules',
    'https://public.example/[client_secret·=privatevalue123]/rules',
    'https://public.example/authorization！=privatevalue123/rules',
    'https://public.example/authori\u0301zation=privatevalue123/rules',
    'https://public.example/authori%CC%81zation=privatevalue123/rules',
    'https://public.example/person\u200B@example.com/rules',
    'https://public.example/person%E2%80%8B@example.com/rules',
    'https://public.example/perso\u0301n@example.com/rules',
    'https://public.example/%252528authorization%252521%25253Dprivatevalue123%252529/rules',
    'https://localhost./rules',
    'https://foo.local./rules',
    'https://[::ffff:127.0.0.1]/rules',
    'https://[::ffff:7f00:1]/rules',
    'https://[::ffff:a00:1]/rules',
    'https://[::ffff:169.254.169.254]/meta',
    'https://[64:ff9b::7f00:1]/rules',
    'https://public.example/rules/ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules?ref=glpat-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules?ref=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules/Bearer%20abcdefghijklmnopqrstuvwxyz123456',
    'https://public.example/rules?ref=Bearer%20abcdefghijklmnopqrstuvwxyz123456',
    'https://public.example/%3Cscript%3Ealert%281%29%3C%2Fscript%3E',
  ];
  const fields = [
    ['source.reference_url', (body, value) => { body.sources[0].reference_url = value; }],
    ['candidate.discovery_url', (body, value) => { body.candidates[0].discovery_url = value; }],
    ['candidate.official_url', (body, value) => { body.candidates[0].official_url = value; }],
  ];
  let caseNumber = 0;
  for (const [field, assign] of fields) {
    for (const value of unsafeUrls) {
      caseNumber += 1;
      const body = competitionFixture();
      body.idempotency_key = `competition-url-probe-${caseNumber}`;
      body.run.id = `competition-url-probe-${caseNumber}`;
      assign(body, value);
      const response = await competitionRequest(env, { body });
      assert.equal(response.status, 400, `${field}: ${value}`);
      assertCompetitionNoStore(response);
      assert.ok(
        ['invalid_report', 'forbidden_data'].includes((await response.json()).error),
        `${field}: ${value}`,
      );
    }
  }
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_sources').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_candidates').get().count), 0);

  const numericContest = competitionFixture();
  numericContest.idempotency_key = 'competition-public-numeric-path';
  numericContest.run.id = 'competition-public-numeric-path';
  numericContest.sources[0].kind = 'official';
  numericContest.sources[0].reference_url = 'https://public.example/contests/20260831123';
  numericContest.candidates[0].discovery_url = 'https://public.example/entries/20260831123';
  numericContest.candidates[0].official_url = 'https://public.example/rules/20260831123';
  const accepted = await competitionRequest(env, { body: numericContest });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition free text rejects compact phones and secret assignments without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const unsafeTexts = [
    '담당자 01012345678',
    'Contact 010 12345678',
    'Contact 010·1234·5678',
    'Contact 010​1234​5678',
    'Contact 010͏1234͏5678',
    'Contact 010️1234️5678',
    'Contact 010̸1234̸5678',
    'Contact 010́1234́5678',
    'Contact 0212345678',
    'Feed(authorization=privatevalue123)',
    '지원자 900101-1234567 아이디어 공모전',
    '지원자: 홍길동 아이디어 공모전',
    '신청자 성명=홍길동',
    '지원자 홍길동의 지원 결과',
    '주소 서울특별시 중구',
    '홍길동 900101 5234567',
    '<b>Example Contest</b>',
    '<script>alert(1)</script>기관',
    'Notice,client_secret=privatevalue123',
    'Agency[refresh_token=privatevalue123]',
    'Secret private_key=privatevalue123',
    'Encoded %28authorization%3Dprivatevalue123%29',
    'Quoted "authorization"="privatevalue123"',
    'Proxy proxy_authorization=privatevalue123',
    'Spaced api key=privatevalue123',
    'Punctuated authorization!=privatevalue123',
    'Middle dot client_secret·=privatevalue123',
    'Full width authorization！=privatevalue123',
    'Combining mark authori\u0301zation=privatevalue123',
    'Format mark person\u200B@example.com',
    'Combining mark perso\u0301n@example.com',
    '문의 %30%31%30%31%32%33%34%35%36%37%38',
  ];
  const fields = [
    ['source-name', (body, value) => { body.sources[0].name = value; }],
    ['candidate-title', (body, value) => { body.candidates[0].title = value; }],
    ['organizer', (body, value) => { body.candidates[0].organizer = value; }],
  ];
  let caseNumber = 0;
  for (const [field, assign] of fields) {
    for (const value of unsafeTexts) {
      caseNumber += 1;
      const body = competitionFixture();
      body.idempotency_key = `competition-private-text-${caseNumber}`;
      body.run.id = `competition-private-text-${caseNumber}`;
      assign(body, value);
      const response = await competitionRequest(env, { body });
      assert.equal(response.status, 400, `${field}: ${value}`);
      assertCompetitionNoStore(response);
      assert.deepEqual(await response.json(), { error: 'forbidden_data' }, `${field}: ${value}`);
      assert.equal(
        Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
        0,
        `${field}: ${value}`,
      );
    }
  }

  const publicNumber = competitionFixture();
  publicNumber.idempotency_key = 'competition-public-number-title';
  publicNumber.run.id = 'competition-public-number-title';
  publicNumber.candidates[0].title = 'Contest 20260831123';
  const accepted = await competitionRequest(env, { body: publicNumber });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition partial source keeps timeout and 403 evidence visibly separate from closed contests', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const fixture = competitionFixture();
  fixture.idempotency_key = 'competition-daily-2026-08-31-partial';
  fixture.run.id = 'competition-2026-08-31-partial';
  fixture.run.status = 'partial';
  fixture.run.source_coverage.succeeded = 0;
  fixture.sources[0].status = 'partial';
  fixture.sources[0].failure_code = 'http_403';
  fixture.sources[0].manual_check = true;
  fixture.sources[0].candidate_count = 0;
  fixture.candidates = [];
  fixture.applications = [];
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.equal(body.summary.partial, true);
  assert.deepEqual(body.sources, [{
    id: 'contest-listing',
    kind: 'listing',
    name: 'Contest Listing',
    reference_url: 'https://list.example/contests/123',
    status: 'partial',
    checked_at: fixture.sources[0].checked_at,
    candidate_count: 0,
    failure_code: 'http_403',
    manual_check: true,
  }]);
  assert.deepEqual(body.candidates, []);
  assert.deepEqual(body.applications, []);
});

test('competition report day uses Asia/Seoul and stale latest scans zero every today count', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const staleKstDate = competitionKstDate(Date.now() - DAY_MS);
  const boundaryStart = Date.parse(`${staleKstDate}T00:01:00+09:00`);
  const fixture = setCompetitionTimeline(competitionFixture(), boundaryStart);
  fixture.idempotency_key = 'competition-kst-boundary';
  fixture.run.id = 'competition-kst-boundary';
  fixture.run.started_at = `${staleKstDate}T00:01:00+09:00`;
  fixture.run.date = staleKstDate;
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);

  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.equal(body.runs[0].date, staleKstDate);
  assert.equal(body.runs[0].started_at, new Date(boundaryStart).toISOString());
  assert.deepEqual(body.summary.today, {
    discovered: 0,
    verified: 0,
    ready: 0,
    awaiting_approval: 0,
    deadline_soon: 0,
  });

  const mismatched = setCompetitionTimeline(competitionFixture(), boundaryStart);
  mismatched.idempotency_key = 'competition-kst-mismatch';
  mismatched.run.id = 'competition-kst-mismatch';
  mismatched.run.date = competitionKstDate(boundaryStart - DAY_MS);
  const rejected = await competitionRequest(env, { body: mismatched });
  assert.equal(rejected.status, 400);
  assertCompetitionNoStore(rejected);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition rejects observations beyond the five-minute future skew without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = setCompetitionTimeline(competitionFixture(), Date.now() + 10 * 60_000);
  fixture.idempotency_key = 'competition-future-scan';
  fixture.run.id = 'competition-future-scan';
  const response = await competitionRequest(env, { body: fixture });
  assert.equal(response.status, 400);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), { error: 'invalid_report' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition evidence cannot follow its report observation while older evidence remains valid', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['future-source-check', (body, future) => { body.sources[0].checked_at = future; }],
    ['future-discovery', (body, future) => { body.candidates[0].discovered_at = future; }],
    ['future-active-verification', (body, future) => {
      body.candidates[0].official_verified_at = future;
    }],
    ['future-application-update', (body, future) => { body.applications[0].updated_at = future; }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-${name}`;
    body.run.id = `competition-${name}`;
    const futureEvidence = new Date(Date.parse(body.run.finished_at) + 60_000).toISOString();
    mutate(body, futureEvidence);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: 'invalid_report' }, name);
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
      0,
      name,
    );
  }

  const beforeDiscovery = competitionFixture();
  beforeDiscovery.idempotency_key = 'competition-application-before-discovery';
  beforeDiscovery.run.id = 'competition-application-before-discovery';
  beforeDiscovery.applications[0].updated_at = new Date(
    Date.parse(beforeDiscovery.candidates[0].discovered_at) - 60_000,
  ).toISOString();
  const beforeDiscoveryResponse = await competitionRequest(env, { body: beforeDiscovery });
  assert.equal(beforeDiscoveryResponse.status, 400);
  assertCompetitionNoStore(beforeDiscoveryResponse);
  assert.deepEqual(await beforeDiscoveryResponse.json(), { error: 'invalid_report' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);

  const carried = competitionFixture();
  carried.idempotency_key = 'competition-carried-evidence';
  carried.run.id = 'competition-carried-evidence';
  const olderDiscovery = new Date(Date.parse(carried.run.started_at) - 2 * DAY_MS).toISOString();
  carried.sources[0].checked_at = olderDiscovery;
  carried.candidates[0].discovered_at = olderDiscovery;
  carried.candidates[0].official_verified_at = new Date(Date.parse(olderDiscovery) + 60_000).toISOString();
  carried.applications[0].updated_at = new Date(Date.parse(olderDiscovery) + 2 * 60_000).toISOString();
  const accepted = await competitionRequest(env, { body: carried });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition latest snapshot follows observation time and deduplicates repeated run ids', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const staleKstDate = competitionKstDate(Date.now() - DAY_MS);
  const midnight = Date.parse(`${staleKstDate}T00:00:00+09:00`);
  const newer = setCompetitionTimeline(competitionFixture(), midnight + 20 * 60 * 60_000);
  newer.idempotency_key = 'competition-repeat-newer';
  newer.run.id = 'competition-repeated-run';
  newer.candidates[0].title = 'Newer observed snapshot';
  const older = setCompetitionTimeline(competitionFixture(), midnight + 18 * 60 * 60_000);
  older.idempotency_key = 'competition-repeat-older';
  older.run.id = 'competition-repeated-run';
  older.candidates[0].title = 'Older late-delivered snapshot';

  const first = await competitionRequest(env, { body: newer });
  const second = await competitionRequest(env, { body: older });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  const body = await looked.json();
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 2);
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].id, 'competition-repeated-run');
  assert.equal(body.runs[0].started_at, newer.run.started_at);
  assert.equal(body.candidates[0].title, 'Newer observed snapshot');
});

test('competition schema rejects unknown, private, unsafe, inconsistent and oversized reports without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const invalid = [];
  const add = (mutate) => {
    const fixture = competitionFixture();
    mutate(fixture);
    invalid.push(fixture);
  };
  add((body) => { body.run.unexpected = true; });
  add((body) => { body.candidates[0].application_answers = { why: 'private prose' }; });
  add((body) => { body.candidates[0].submission_payload = { action: 'submit' }; });
  add((body) => { body.applications[0].final_submission = true; });
  add((body) => { body.applications[0].legal_consent = true; });
  add((body) => { body.applications[0].payment = { amount: 10 }; });
  add((body) => { body.applications[0].receipt = 'organizer receipt'; });
  add((body) => { body.applications[0].email = 'person@example.com'; });
  add((body) => { body.candidates[0].discovery_url = 'http://list.example/contests/123'; });
  add((body) => { body.candidates[0].official_url = 'https://127.0.0.1/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://localhost/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://10.0.0.1/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://user:secret@organizer.example/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://organizer.example/rules#private'; });
  add((body) => { body.candidates[0].official_url = 'https://list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www2.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://rules.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www.list.example../official-looking-rules'; });
  add((body) => {
    body.candidates[0].discovery_url = 'https://list.example/contests/123?email=person%40example.com';
  });
  add((body) => { body.run.started_at = '2026-08-31T00:00:00'; });
  add((body) => { body.candidates[0].status = 'preparing'; });
  add((body) => { body.candidates[0].eligibility = 'unknown'; });
  add((body) => {
    body.sources[0].status = 'failed';
    body.sources[0].failure_code = 'timeout';
    body.sources[0].manual_check = false;
    body.run.status = 'partial';
    body.run.source_coverage.succeeded = 0;
  });
  add((body) => {
    body.applications = Array.from({ length: 4 }, (_, index) => ({
      ...body.applications[0],
      contest_id: `organizer-2026-image-${index}`,
      profile_id: `hmac-sha256:${String(index).repeat(64)}`,
    }));
  });
  for (const body of invalid) {
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400);
    assertCompetitionNoStore(response);
    assert.ok(['invalid_report', 'forbidden_data'].includes((await response.json()).error));
  }
  const tooLarge = await worker.fetch(new Request('https://api.test/api/competitions/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer competition-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(1_000_001) }),
  }), env);
  assert.equal(tooLarge.status, 413);
  assertCompetitionNoStore(tooLarge);
  assert.deepEqual(await tooLarge.json(), { error: 'report_too_large' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_sources').get().count), 0);
});

test('competition accepted-report batch rolls back every normalized table on a child failure', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  database.exec(`
    CREATE TRIGGER competition_test_source_failure
    BEFORE INSERT ON competition_sources
    BEGIN SELECT RAISE(ABORT, 'forced competition child failure'); END;
  `);
  t.mock.method(console, 'error', () => {});
  const response = await competitionRequest(env, { body: competitionFixture() });
  assert.equal(response.status, 500);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), { error: '서버 오류' });
  for (const table of [
    'competition_reports', 'competition_sources', 'competition_candidates',
    'competition_applications',
  ]) {
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0);
  }
});

// Password-reset regression fixtures are isolated in-memory accounts, never live credentials.
async function passwordResetContext(t) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (const migration of ['0001_init.sql', '0004_session_ip_address.sql', '0008_login_attempt_limits.sql']) {
    database.exec(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const createdAt = Date.now() - 60_000;
  const oldPassword = 'Old-password-for-reset-tests!';
  const salt = 'isolated-reset-fixture-salt';
  const hash = await passwordHash(oldPassword, salt);
  const insertUser = database.prepare(`
    INSERT INTO users(id, username, password_hash, password_salt, created_at, disabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(1, 'reset-target', hash, salt, createdAt, 0);
  insertUser.run(2, 'other-user', hash, salt, createdAt, 0);
  insertUser.run(3, 'disabled-user', hash, salt, createdAt, 1);
  const insertSession = database.prepare(`
    INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [token, userId, role, expiry] of [
    ['reset-admin-token', null, 'admin', Date.now() + DAY_MS],
    ['reset-expired-admin-token', null, 'admin', Date.now() - 1_000],
    ['reset-user-token', 1, 'user', Date.now() + DAY_MS],
    ['reset-second-device', 1, 'user', Date.now() + DAY_MS],
    ['reset-linked-admin', 1, 'admin', Date.now() + DAY_MS],
    ['reset-expired-user', 1, 'user', Date.now() - 1_000],
    ['reset-other-token', 2, 'user', Date.now() + DAY_MS],
    ['reset-disabled-admin', 3, 'admin', Date.now() + DAY_MS],
  ]) {
    insertSession.run(await sha256(token), userId, role, createdAt, expiry, createdAt, 'Fixture browser');
  }
  database.prepare('INSERT INTO progress(user_id, app, data, updated_at) VALUES (?, ?, ?, ?)')
    .run(1, 'wordmaster', '{"done":[1,2,3]}', createdAt);
  database.prepare(`
    INSERT INTO shared_answers(app, question_id, normalized_answer, display_answer, created_by, created_at)
    VALUES ('wordmaster', 'fixture-word', 'fixture', 'fixture', 1, ?)
  `).run(createdAt);
  return {
    database,
    oldPassword,
    env: { ALLOWED_ORIGIN: 'https://example.test', DB: sqliteD1(database) },
  };
}

function resetRequest(body = { password: 'Replacement-password-for-tests!' }, token = 'reset-admin-token', id = '1', method = 'POST') {
  return new Request(`https://api.test/api/admin/users/${id}/password`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

function assertResetNoStore(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.test');
}

test('password reset requires an active administrator before looking up a target', async (t) => {
  const { database, env } = await passwordResetContext(t);
  const before = database.prepare('SELECT * FROM users').all();
  for (const token of ['', 'unknown-token', 'reset-user-token', 'reset-other-token', 'reset-expired-admin-token', 'reset-disabled-admin']) {
    for (const id of ['1', '999999']) {
      const response = await worker.fetch(resetRequest(undefined, token, id), env);
      assert.equal(response.status, 401, `${token || 'anonymous'} ${id}`);
      assertResetNoStore(response);
      assert.deepEqual(await response.json(), { error: '관리자 로그인이 필요합니다.' });
    }
  }
  assert.deepEqual(database.prepare('SELECT * FROM users').all(), before);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE event = 'password_reset_by_admin'").get().count, 0);
});

test('password reset rejects invalid ids, malformed payloads and wrong methods without changing a password', async (t) => {
  const { database, env } = await passwordResetContext(t);
  const before = database.prepare('SELECT * FROM users').all();
  for (const id of ['0', '-1', '1.5', '01', 'abc', '9007199254740992']) {
    const response = await worker.fetch(resetRequest(undefined, 'reset-admin-token', id), env);
    assert.equal(response.status, 400, id);
    assertResetNoStore(response);
  }
  for (const body of [null, [], {}, { password: null }, { password: 123456 }, { password: ['123456'] },
    { password: 'short' }, { password: '      ' }, { password: 'a'.repeat(129) }]) {
    const response = await worker.fetch(resetRequest(body), env);
    assert.equal(response.status, 400);
    assertResetNoStore(response);
  }
  const malformed = new Request('https://api.test/api/admin/users/1/password', {
    method: 'POST', headers: { authorization: 'Bearer reset-admin-token', 'content-type': 'application/json' }, body: '{',
  });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await worker.fetch(resetRequest(undefined, 'reset-admin-token', '1', method), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assertResetNoStore(response);
  }
  assert.deepEqual(database.prepare('SELECT * FROM users').all(), before);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM activity').get().count, 0);
});

test('password reset returns a non-cached 404 for a missing account without affecting other accounts', async (t) => {
  const { database, env } = await passwordResetContext(t);
  const before = database.prepare('SELECT * FROM users').all();
  const response = await worker.fetch(resetRequest(undefined, 'reset-admin-token', '999999'), env);
  assert.equal(response.status, 404);
  assertResetNoStore(response);
  assert.deepEqual(database.prepare('SELECT * FROM users').all(), before);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM activity').get().count, 0);
});

test('password reset changes only the target hash, expires every target device and preserves learning and history', async (t) => {
  const { database, env, oldPassword } = await passwordResetContext(t);
  const before = database.prepare('SELECT * FROM users WHERE id = 1').get();
  const other = database.prepare('SELECT * FROM users WHERE id = 2').get();
  const progress = database.prepare('SELECT * FROM progress').all();
  const answers = database.prepare('SELECT * FROM shared_answers').all();
  const history = database.prepare('SELECT * FROM sessions WHERE user_id = 1 ORDER BY token_hash').all();
  const password = '  공백을 보존하는 새 비밀번호!  ';
  const response = await worker.fetch(resetRequest({ password }), env);
  assert.equal(response.status, 200);
  assertResetNoStore(response);
  assert.deepEqual(await response.json(), { ok: true });
  const after = database.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.notEqual(after.password_salt, before.password_salt);
  assert.notEqual(after.password_hash, before.password_hash);
  assert.equal(after.password_hash, await passwordHash(password, after.password_salt));
  assert.equal(after.created_at, before.created_at);
  assert.equal(after.last_login_at, before.last_login_at);
  assert.equal(after.disabled, before.disabled);
  assert.deepEqual(database.prepare('SELECT * FROM users WHERE id = 2').get(), other);
  assert.deepEqual(database.prepare('SELECT * FROM progress').all(), progress);
  assert.deepEqual(database.prepare('SELECT * FROM shared_answers').all(), answers);
  const afterHistory = database.prepare('SELECT * FROM sessions WHERE user_id = 1 ORDER BY token_hash').all();
  assert.equal(afterHistory.length, history.length);
  for (let index = 0; index < history.length; index += 1) {
    assert.ok(afterHistory[index].expires_at <= Date.now());
    assert.deepEqual({ ...afterHistory[index], expires_at: history[index].expires_at }, { ...history[index] });
    assert.ok(afterHistory[index].expires_at <= history[index].expires_at, 'never revive or extend a session');
  }
  const audit = database.prepare("SELECT user_id, event, app, detail FROM activity WHERE event = 'password_reset_by_admin'").get();
  assert.deepEqual({ ...audit }, { user_id: 1, event: 'password_reset_by_admin', app: null, detail: null });
  for (const token of ['reset-user-token', 'reset-second-device', 'reset-linked-admin']) {
    const me = await worker.fetch(new Request('https://api.test/api/me', { headers: { authorization: `Bearer ${token}` } }), env);
    assert.equal(me.status, 401);
  }
  for (const token of ['reset-admin-token', 'reset-other-token']) {
    const me = await worker.fetch(new Request('https://api.test/api/me', { headers: { authorization: `Bearer ${token}` } }), env);
    assert.equal(me.status, 200, 'unrelated sessions stay active');
  }
  assert.equal((await worker.fetch(loginRequest('/api/login', { username: 'reset-target', password: oldPassword }), env)).status, 401);
  const freshLogin = await worker.fetch(loginRequest('/api/login', { username: 'reset-target', password }), env);
  assert.equal(freshLogin.status, 200);
  const { token } = await freshLogin.json();
  assert.ok(token);
  const freshMe = await worker.fetch(new Request('https://api.test/api/me', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(freshMe.status, 200);
});

test('password reset accepts both policy boundaries and rotates salt even for a repeated password', async (t) => {
  const { database, env } = await passwordResetContext(t);
  let lastSalt = database.prepare('SELECT password_salt FROM users WHERE id = 1').get().password_salt;
  for (const password of ['abcdef', 'a'.repeat(128), 'a'.repeat(128)]) {
    assert.equal((await worker.fetch(resetRequest({ password }), env)).status, 200);
    const current = database.prepare('SELECT password_hash, password_salt FROM users WHERE id = 1').get();
    assert.notEqual(current.password_salt, lastSalt);
    assert.equal(current.password_hash, await passwordHash(password, current.password_salt));
    lastSalt = current.password_salt;
  }
});

test('password reset never re-enables a disabled user', async (t) => {
  const { database, env } = await passwordResetContext(t);
  assert.equal((await worker.fetch(resetRequest(undefined, 'reset-admin-token', '3'), env)).status, 200);
  assert.equal(database.prepare('SELECT disabled FROM users WHERE id = 3').get().disabled, 1);
  const login = await worker.fetch(loginRequest('/api/login', {
    username: 'disabled-user', password: 'Replacement-password-for-tests!',
  }), env);
  assert.equal(login.status, 401);
});

test('password reset rolls back credentials, revocations and audit when any batch statement fails', async (t) => {
  for (const failAt of ['sessions', 'activity']) {
    await t.test(failAt, async (subtest) => {
      const { database, env } = await passwordResetContext(subtest);
      const users = database.prepare('SELECT * FROM users').all();
      const sessions = database.prepare('SELECT * FROM sessions WHERE user_id IS NOT NULL').all();
      database.exec(failAt === 'sessions'
        ? "CREATE TRIGGER fail_reset BEFORE UPDATE OF expires_at ON sessions BEGIN SELECT RAISE(ABORT, 'fixture-expiry-failure'); END"
        : "CREATE TRIGGER fail_reset BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'fixture-audit-failure'); END");
      const logs = [];
      subtest.mock.method(console, 'error', (...values) => logs.push(values));
      const response = await worker.fetch(resetRequest(), env);
      assert.equal(response.status, 500);
      assertResetNoStore(response);
      assert.deepEqual(logs, [['admin_password_reset_failed']]);
      assert.deepEqual(database.prepare('SELECT * FROM users').all(), users);
      assert.deepEqual(database.prepare('SELECT * FROM sessions WHERE user_id IS NOT NULL').all(), sessions);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM activity').get().count, 0);
    });
  }
});

test('password reset also redacts unexpected authentication errors and disables caching on failure', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: { prepare() { throw new Error('sensitive-database-diagnostic-fixture'); } },
  };
  const response = await worker.fetch(resetRequest(), env);
  assert.equal(response.status, 500);
  assertResetNoStore(response);
  assert.deepEqual(logs, [['password_reset_request_failed']]);
  assert.deepEqual(await response.json(), { error: '서버 오류' });
});

test('an in-flight login cannot issue a new session after the verified password was reset', async (t) => {
  const { database, env, oldPassword } = await passwordResetContext(t);
  const originalDb = env.DB;
  let intercepted = false;
  const racingDb = {
    ...originalDb,
    prepare(sql) {
      const statement = originalDb.prepare(sql);
      if (!sql.includes('INSERT INTO sessions')) return statement;
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          return {
            async run() {
              intercepted = true;
              const reset = await worker.fetch(resetRequest(), env);
              assert.equal(reset.status, 200);
              return bound.run();
            },
          };
        },
      };
    },
  };
  const response = await worker.fetch(loginRequest('/api/login', {
    username: 'reset-target', password: oldPassword,
  }), { ...env, DB: racingDb });
  assert.equal(intercepted, true);
  assert.equal(response.status, 401);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = 1 AND expires_at > ?').get(Date.now()).count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE event = 'login'").get().count, 0);
});
