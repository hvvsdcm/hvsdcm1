import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import worker from './src/index.js';
import { resetUserPassword } from './src/password-reset.js';
import { issueSession, passwordHash, sha256 } from './src/lib.js';

async function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of ['0001_init.sql', '0004_session_ip_address.sql', '0008_login_attempt_limits.sql']) sql.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
  const oldPassword = `old-${randomUUID()}`;
  const oldHash = await passwordHash(oldPassword, 'local-fixture-salt');
  sql.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (1, ?, ?, ?, ?), (2, ?, ?, ?, ?)').run('fixture-user', oldHash, 'local-fixture-salt', Date.now(), 'fixture-other', oldHash, 'local-fixture-salt', Date.now());
  sql.prepare('INSERT INTO progress VALUES (1, ?, ?, ?)').run('wordmaster', JSON.stringify({ stats: { w1: { correct: 2 } } }), Date.now());
  const tokens = { admin: randomUUID(), user: randomUUID(), other: randomUUID() };
  for (const [role, token] of Object.entries(tokens)) {
    sql.prepare('INSERT INTO sessions (token_hash,user_id,role,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)').run(await sha256(token), role === 'admin' ? null : role === 'user' ? 1 : 2, role === 'admin' ? 'admin' : 'user', Date.now(), Date.now() + 86_400_000, Date.now());
  }
  const DB = {
    beforeBatch: null, failBatch: false,
    prepare(query) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sql.prepare(query).get(...values) || null; },
        async all() { return { results: sql.prepare(query).all(...values) }; },
        async run() { const r = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
    },
    async batch(statements) {
      if (DB.beforeBatch) DB.beforeBatch();
      sql.exec('BEGIN');
      try {
        const results = [];
        for (let i = 0; i < statements.length; i++) {
          if (DB.failBatch && i === 2) throw new Error('fixture failure');
          results.push(await statements[i].run());
        }
        sql.exec('COMMIT'); return results;
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, ALLOWED_ORIGIN: 'https://example.test' };
  const send = (url, body, token = tokens.admin, method = 'POST') => worker.fetch(new Request(`https://api.example.test${url}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);
  return { sql, DB, env, send, tokens, oldPassword, oldHash };
}
const url = '/api/admin/users/1/reset-password';
const body = () => { const password = `new-${randomUUID()}`; return { password, confirmPassword: password }; };

test('admin reset rotates salted hash, expires only target sessions, keeps progress and records an audit event', async () => {
  const f = await fixture();
  try {
    const input = body();
    const response = await f.send(url, input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const output = await response.text();
    assert.equal(output, '{"ok":true}');
    assert.ok(!output.includes(input.password));
    const user = f.sql.prepare('SELECT * FROM users WHERE id=1').get();
    assert.notEqual(user.password_salt, 'local-fixture-salt');
    assert.equal(user.password_hash, await passwordHash(input.password, user.password_salt));
    assert.notEqual(user.password_hash, f.oldHash);
    assert.equal((await f.send('/api/me', null, f.tokens.user, 'GET')).status, 401);
    assert.equal((await f.send('/api/me', null, f.tokens.other, 'GET')).status, 200);
    assert.ok(f.sql.prepare("SELECT expires_at FROM sessions WHERE role='admin'").get().expires_at > Date.now());
    assert.equal(f.sql.prepare('SELECT data FROM progress WHERE user_id=1').get().data, '{"stats":{"w1":{"correct":2}}}');
    assert.deepEqual({ ...f.sql.prepare("SELECT event,detail FROM activity WHERE event='password_reset_by_admin'").get() }, { event: 'password_reset_by_admin', detail: null });
    assert.equal((await f.send('/api/login', { username: 'fixture-user', password: f.oldPassword }, '')).status, 401);
    const login = await f.send('/api/login', { username: 'fixture-user', password: input.password }, '');
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    assert.equal((await f.send('/api/me', null, token, 'GET')).status, 200);
  } finally { f.sql.close(); }
});

test('ordinary users and anonymous callers cannot reset any password', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send(url, body(), '')).status, 401);
    assert.equal((await f.send(url, body(), f.tokens.user)).status, 401);
    assert.equal(f.sql.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash, f.oldHash);
  } finally { f.sql.close(); }
});

test('validation rejects mismatches, weak or unbounded input without changes', async () => {
  const f = await fixture();
  try {
    for (const input of [{ password: 'short', confirmPassword: 'short' }, { password: '12345678', confirmPassword: '87654321' }, { password: ' '.repeat(10), confirmPassword: ' '.repeat(10) }, { password: 12345678, confirmPassword: 12345678 }, { password: 'a'.repeat(129), confirmPassword: 'a'.repeat(129) }, [], 'not json']) {
      assert.equal((await f.send(url, input)).status, 400);
    }
    assert.equal((await f.send(url, 'x'.repeat(4097))).status, 413);
    assert.equal((await f.send('/api/admin/users/999/reset-password', body())).status, 404);
    assert.equal((await f.send('/api/admin/users/9007199254740992/reset-password', body())).status, 400);
    assert.equal(f.sql.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash, f.oldHash);
  } finally { f.sql.close(); }
});

test('concurrent password replacement is compare-and-swap guarded', async () => {
  const f = await fixture();
  try {
    f.DB.beforeBatch = () => f.sql.prepare('UPDATE users SET password_hash=? WHERE id=1').run('competing-update');
    assert.equal((await f.send(url, body())).status, 409);
    assert.equal(f.sql.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash, 'competing-update');
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM activity WHERE event='password_reset_by_admin'").get().n, 0);
    assert.equal((await f.send('/api/me', null, f.tokens.user, 'GET')).status, 200);
  } finally { f.sql.close(); }
});

test('transaction failure rolls back password and session mutations together', async () => {
  const f = await fixture();
  try {
    f.DB.failBatch = true;
    assert.equal((await f.send(url, body())).status, 500);
    assert.equal(f.sql.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash, f.oldHash);
    assert.equal((await f.send('/api/me', null, f.tokens.user, 'GET')).status, 200);
  } finally { f.sql.close(); }
});

test('a login racing a reset cannot issue a session from a stale password hash', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send(url, body())).status, 200);
    const token = await issueSession(f.env, 1, 'user', new Request('https://example.test'), f.oldHash);
    assert.equal(token, null);
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=1 AND expires_at>?").get(Date.now()).n, 0);
  } finally { f.sql.close(); }
});

test('reset handler also rejects non-admin direct invocation', async () => {
  const f = await fixture();
  try {
    const response = await resetUserPassword(new Request('https://example.test', { method: 'POST', body: JSON.stringify(body()) }), f.env, 1, { role: 'user' });
    assert.equal(response.status, 401);
  } finally { f.sql.close(); }
});

test('WordMaster accommodates the added schedule within a strict UTF-8 limit; other apps retain their limit', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('/api/progress/wordmaster', { data: { fixture: 'x'.repeat(900_000) } }, f.tokens.user, 'PUT')).status, 200);
    assert.equal((await f.send('/api/progress/wordmaster', { data: { fixture: 'x'.repeat(1_200_000) } }, f.tokens.user, 'PUT')).status, 413);
    assert.equal((await f.send('/api/progress/wordmaster', { data: { fixture: '가'.repeat(410_000) } }, f.tokens.user, 'PUT')).status, 413);
    assert.equal((await f.send('/api/progress/smstudy', { data: { fixture: 'x'.repeat(800_000) } }, f.tokens.user, 'PUT')).status, 413);
  } finally { f.sql.close(); }
});
