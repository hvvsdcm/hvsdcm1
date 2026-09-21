import {
  DAY_MS,
  authenticate,
  clientIp,
  createToken,
  issueSession,
  json,
  logActivity,
  normalizeAnswer,
  now,
  passwordHash,
  readJson,
  sha256,
} from './lib.js';
import { resetUserPassword } from './password-reset.js';
import {
  decideCompetitionApproval,
  getCompetitions,
  reportCompetitions,
} from './competitions.js';

const MAX_PROGRESS_BYTES = 800_000;
// 사용량 스냅샷은 rate_limits 몇 개짜리 객체다. 상한이 없으면 ingest 토큰이 새거나
// 수집기 버그 하나로 D1 행이 무제한으로 부푼다.
const MAX_BEHAVIOR_PAPER_BYTES = 96_000;
export const MAX_MULTI_PAPER_BYTES = 282_000;
const MAX_ABC_EQUITY_CURVE_POINTS = 64;
const MAX_BEHAVIOR_PAPER_SEQUENCE = 1_000_000;
const MAX_BEHAVIOR_PAPER_TRADES = 25;
const MAX_BEHAVIOR_PAPER_LOGS = 50;
const MAX_BEHAVIOR_ADAPTIVE_CHALLENGERS = 8;
const MAX_BEHAVIOR_ADAPTIVE_AUDIT_LOGS = 20;
export const BEHAVIOR_PAPER_SESSION_ID = 'paper-20260831-100usd';
export const BEHAVIOR_PAPER_DEADLINE = '2026-08-30T23:00:00.000Z';
export const BEHAVIOR_PAPER_SNAPSHOT_SOURCE = `behavior-paper:${BEHAVIOR_PAPER_SESSION_ID}`;
export const BEHAVIOR_ABC_EXPERIMENT_ID = 'abc-paper-20260831';
export const BEHAVIOR_ABC_SNAPSHOT_SOURCE = `behavior-paper-experiment:${BEHAVIOR_ABC_EXPERIMENT_ID}`;
export const BEHAVIOR_MULTI_EXPERIMENT_ID = 'multi-paper-binance-20260901-v1';
export const BEHAVIOR_MULTI_SNAPSHOT_SOURCE = `behavior-paper-experiment:${BEHAVIOR_MULTI_EXPERIMENT_ID}`;
export const BEHAVIOR_MULTI_CONTROL_SOURCE = `behavior-paper-control:${BEHAVIOR_MULTI_EXPERIMENT_ID}`;
export const BEHAVIOR_LIVE_EXPERIMENT_ID = 'dual-live-20260901-v1';
export const BEHAVIOR_LIVE_SNAPSHOT_SOURCE = `behavior-live:${BEHAVIOR_LIVE_EXPERIMENT_ID}`;
const MAX_BEHAVIOR_LIVE_BYTES = 48_000;
const ABC_ARM_IDS = ['A', 'B', 'C'];
const ABC_STRATEGY_IDS = {
  A: 'abc-trend-momentum-v1', B: 'abc-breakout-volatility-v1', C: 'abc-mean-reversion-crowd-fade-v1',
};
const ABC_STRATEGY_LABELS = {
  A: 'Trend / momentum', B: 'Breakout / volatility', C: 'Mean reversion / crowd fade',
};
const MULTI_ARM_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MULTI_FEE_RATE = 6 / 10_000;
const MULTI_ADVERSE_SLIPPAGE_RATE = 4 / 10_000;
const MULTI_STRATEGIES = {
  A: { id: 'multi-trend-persistence-v3', label: 'Trend persistence',
    definition_hash: '61b98082823a210087ace1472883fe18a8f6f8268dec9f53e76b3b3b72ad8ae4', style: 'trend-continuation',
    allowed_regimes: ['trend-up', 'trend-down'], required_features: ['trendMomentum'],
    minimum_feature_agreement: 2, min_persistence_seconds: 3, entry_threshold: .28,
    max_spread_bps: 4, min_target_bps: 32, min_net_reward_risk: 1.25, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  B: { id: 'multi-breakout-confirmation-v3', label: 'Breakout confirmation',
    definition_hash: '8873352d336b081916e70bae1ee83e22bbc3e369f8592d7063b0f5131b7aaee7', style: 'breakout-confirmation',
    allowed_regimes: ['trend-up', 'trend-down', 'range'], required_features: ['breakout'],
    minimum_feature_agreement: 2, min_persistence_seconds: 3, entry_threshold: .28,
    max_spread_bps: 3.5, min_target_bps: 35, min_net_reward_risk: 1.25, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  C: { id: 'multi-range-reversion-v3', label: 'Range reversion',
    definition_hash: 'db16839b63dcd67f00bae7e134842530a83a4deed823cfbd8ae800d189f95edd', style: 'range-reversion',
    allowed_regimes: ['range'], required_features: ['meanReversion'], minimum_feature_agreement: 2,
    min_persistence_seconds: 4, entry_threshold: .34, max_spread_bps: 4, min_target_bps: 32,
    min_net_reward_risk: 1.2, cooldown_minutes: 10, opposite_confirmations: 2 },
  D: { id: 'multi-ofi-continuation-v3', label: 'Order-flow continuation',
    definition_hash: '35df86229264db1e3ae426e80205384103af9fa1226e0c7a78c1af5244512e0e', style: 'order-flow-continuation',
    allowed_regimes: ['trend-up', 'trend-down', 'range'], required_features: ['orderFlow'],
    minimum_feature_agreement: 2, min_persistence_seconds: 5, entry_threshold: .4,
    max_spread_bps: 3, min_target_bps: 36, min_net_reward_risk: 1.25, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  E: { id: 'multi-overreaction-fade-v3', label: 'Range overreaction fade',
    definition_hash: 'd1173d71fe7a07e8b95e5bc84e3bbc9cdeb2de63aa0f0529c773d5b0acd8b65e', style: 'overreaction-fade',
    allowed_regimes: ['range'], required_features: ['meanReversion'], minimum_feature_agreement: 2,
    min_persistence_seconds: 4, entry_threshold: .42, max_spread_bps: 3.5, min_target_bps: 34,
    min_net_reward_risk: 1.25, cooldown_minutes: 12, opposite_confirmations: 2 },
  F: { id: 'multi-consensus-conservative-v3', label: 'Conservative consensus',
    definition_hash: '9adcbd0ffed74e9d26bbc971b8c66a5f4cb3113bc1236b68a690e5856d9c109b', style: 'multi-factor-consensus',
    allowed_regimes: ['trend-up', 'trend-down', 'range'], required_features: [], minimum_feature_agreement: 2,
    min_persistence_seconds: 4, entry_threshold: .34, max_spread_bps: 3, min_target_bps: 38,
    min_net_reward_risk: 1.3, cooldown_minutes: 15, opposite_confirmations: 3 },
};
const MULTI_STRATEGY_SET_HASH = 'e8c8095f59bab11d6a6c1060c6278fa37af07a2101073391eaa2bec405c671ac';
const VALID_ABC_EVENT_TYPES = new Set([
  'arm-started', 'decision', 'position-opened', 'position-marked', 'position-closed', 'arm-terminal', 'arm-error',
]);
const VALID_MULTI_EVENT_TYPES = new Set([...VALID_ABC_EVENT_TYPES, 'entry-rejected']);
const VALID_MULTI_GATE_REASONS = new Set([
  'warmup-incomplete', 'regime-warmup-incomplete', 'invalid-quote', 'stress-regime', 'regime-mismatch',
  'spread-too-wide', 'score-below-threshold', 'persistence-insufficient', 'feature-agreement-insufficient',
  'required-feature-mismatch', 'trend-direction-mismatch', 'target-below-cost-floor',
  'net-reward-risk-insufficient', 'post-exit-cooldown', 'candidate-stale',
]);
const VALID_BEHAVIOR_PAPER_STATUSES = new Set(['starting', 'active', 'halted', 'complete', 'error']);
const VALID_BEHAVIOR_PAPER_LOG_TYPES = new Set([
  'session-started', 'cycle-error', 'risk-halted', 'entry-cutoff', 'position-opened',
  'signal-observed', 'no-signal', 'position-closed', 'position-marked', 'session-terminal',
  'settlement-pending', 'checkpoint', 'strategy-upgraded', 'realtime-no-trade', 'realtime-decision',
  'strategy-promoted', 'strategy-rolled-back', 'strategy-checkpoint',
]);
const VALID_BEHAVIOR_ADAPTIVE_STREAM_STATUSES = new Set(['connecting', 'live', 'stale', 'stopped', 'error']);
const VALID_BEHAVIOR_ADAPTIVE_PROMOTION_STATUSES = new Set(['collecting', 'held', 'promoted', 'rolled-back']);
const VALID_BEHAVIOR_ADAPTIVE_PROMOTION_REASONS = new Set([
  'minimum-evidence-not-yet-complete', 'minimum-age', 'minimum-trades', 'multi-window-stability',
  'net-expectancy', 'drawdown', 'turnover-cost', 'all-bounded-gates-passed', 'post-promotion-drawdown-breach',
]);
const VALID_BEHAVIOR_ADAPTIVE_AUDIT_KINDS = new Set([
  'engine-start', 'connection', 'reconnect', 'heartbeat', 'raw-packet', 'normalized-packet',
  'packet-rejected', 'stream-gap', 'stream-stale', 'feature', 'strategy-vote', 'no-trade',
  'shadow-fill', 'shadow-result', 'position-transition', 'checkpoint', 'promotion', 'rollback',
  'report-attempt', 'report-error', 'engine-stop',
]);
const FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_ALIASES = new Set([
  'authorization', 'authentication', 'auth', 'apikey', 'apisecret', 'apitoken',
  'secret', 'secretkey', 'token', 'authtoken', 'bearertoken', 'accesstoken',
  'refreshtoken', 'sessiontoken', 'accesskey', 'accesssecret', 'privatekey',
  'passphrase', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'jwt',
  'signature', 'signingkey', 'clientoid', 'clientorderid', 'clordid', 'orderid',
  'accountid', 'subaccountid', 'userid', 'uid', 'subuid', 'oid', 'tradeid',
  'fillid', 'accesssign', 'privatefield',
  'privatedata', 'privateroute', 'privatechannel',
]);
const FORBIDDEN_BEHAVIOR_PAPER_CREDENTIAL_TOKENS = new Set([
  'authorization', 'authentication', 'secret', 'token', 'passphrase', 'password',
  'passwd', 'pwd', 'credential', 'credentials', 'jwt', 'signature',
]);
const FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_SUFFIXES = [
  'apikey', 'apisecret', 'apitoken', 'secretkey', 'authtoken', 'bearertoken',
  'accesstoken', 'refreshtoken', 'sessiontoken', 'accesskey', 'accesssecret',
  'privatekey', 'passphrase', 'password', 'credential', 'credentials', 'signature',
  'clientoid', 'clientorderid', 'clordid', 'orderid', 'accountid', 'subaccountid',
  'userid', 'subuid', 'tradeid', 'fillid', 'accesssign',
];
const SESSION_HISTORY_MS = 90 * DAY_MS;
const VALID_APPS = new Set(['wordmaster', 'smstudy', 'plstudy']);
const ingestTokenEncoder = new TextEncoder();
const LOGIN_MINUTE_MS = 60_000;
const LOGIN_FAILURE_WINDOW_MS = 60 * LOGIN_MINUTE_MS;
const LOGIN_LOCK_MS = 15 * LOGIN_MINUTE_MS;
const LOGIN_ATTEMPTS_PER_MINUTE = 5;
const LOGIN_FAILURES_PER_WINDOW = 10;
const GICHUL_HEADERS = Object.freeze({
  'cache-control': 'no-store',
});
const LEARNING_CONTENT_KEYS = Object.freeze({
  wordmaster: 'learning/wordmaster.json',
  smstudy: 'learning/smstudy.json',
  plstudy: 'learning/plstudy.json',
});

export function fixedTimeEqual(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  // Node's Web Crypto test runtime does not expose the Workers extension.
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function fixedTimeTextEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', ingestTokenEncoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', ingestTokenEncoder.encode(String(right))),
  ]);
  return fixedTimeEqual(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

function rateLimitResponse(retryAt, attemptedAt) {
  const retryAfter = Math.max(1, Math.ceil((retryAt - attemptedAt) / 1_000));
  return json(
    { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
    429,
    { 'retry-after': String(retryAfter) },
  );
}

async function beginLoginAttempt(request, env, scope, account) {
  const attemptedAt = now();
  const normalizedAccount = String(account || '').normalize('NFKC').toLowerCase();
  const keyHash = await sha256(JSON.stringify([scope, clientIp(request), normalizedAccount]));
  const state = await env.DB.prepare(`
    INSERT INTO login_attempt_limits(
      key_hash, minute_started_at, minute_attempts,
      failure_window_started_at, failure_count, locked_until, updated_at
    ) VALUES (?1, ?2, 1, NULL, 0, 0, ?2)
    ON CONFLICT(key_hash) DO UPDATE SET
      minute_started_at = CASE
        WHEN login_attempt_limits.minute_started_at <= ?3 THEN excluded.minute_started_at
        ELSE login_attempt_limits.minute_started_at
      END,
      minute_attempts = CASE
        WHEN login_attempt_limits.minute_started_at <= ?3 THEN 1
        ELSE login_attempt_limits.minute_attempts + 1
      END,
      updated_at = excluded.updated_at
    RETURNING minute_started_at, minute_attempts, locked_until
  `).bind(keyHash, attemptedAt, attemptedAt - LOGIN_MINUTE_MS).first();

  const lockedUntil = Number(state?.locked_until || 0);
  const minuteRetryAt = Number(state?.minute_attempts || 0) > LOGIN_ATTEMPTS_PER_MINUTE
    ? Number(state.minute_started_at) + LOGIN_MINUTE_MS
    : 0;
  const retryAt = Math.max(lockedUntil, minuteRetryAt);
  return {
    attemptedAt,
    keyHash,
    response: retryAt > attemptedAt ? rateLimitResponse(retryAt, attemptedAt) : null,
  };
}

async function recordLoginFailure(env, attempt) {
  const lockUntil = attempt.attemptedAt + LOGIN_LOCK_MS;
  const state = await env.DB.prepare(`
    UPDATE login_attempt_limits
    SET failure_window_started_at = CASE
          WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN ?2
          ELSE failure_window_started_at
        END,
        failure_count = CASE
          WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN 1
          ELSE failure_count + 1
        END,
        locked_until = CASE
          WHEN (CASE
            WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN 1
            ELSE failure_count + 1
          END) >= ?5 THEN MAX(locked_until, ?4)
          ELSE locked_until
        END,
        updated_at = ?2
    WHERE key_hash = ?1
    RETURNING failure_count, locked_until
  `).bind(
    attempt.keyHash,
    attempt.attemptedAt,
    attempt.attemptedAt - LOGIN_FAILURE_WINDOW_MS,
    lockUntil,
    LOGIN_FAILURES_PER_WINDOW,
  ).first();

  return Number(state?.locked_until || 0) > attempt.attemptedAt
    ? rateLimitResponse(Number(state.locked_until), attempt.attemptedAt)
    : null;
}

async function clearLoginFailures(env, attempt) {
  await env.DB.prepare(`
    UPDATE login_attempt_limits
    SET failure_window_started_at = NULL,
        failure_count = 0,
        locked_until = 0,
        updated_at = ?2
    WHERE key_hash = ?1
  `).bind(attempt.keyHash, attempt.attemptedAt).run();
}

async function login(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const attempt = await beginLoginAttempt(request, env, 'user', username);
  if (attempt.response) return attempt.response;

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();

  const suppliedHash = user
    ? await passwordHash(String(input.password || ''), user.password_salt)
    : null;
  const passwordMatches = user
    ? await fixedTimeTextEqual(suppliedHash, user.password_hash)
    : false;
  if (!user || user.disabled || !passwordMatches) {
    const locked = await recordLoginFailure(env, attempt);
    if (locked) return locked;
    return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  await clearLoginFailures(env, attempt);
  const rawToken = await issueSession(env, user.id, 'user', request, user.password_hash);
  if (!rawToken) return json({ error: '비밀번호가 변경되었습니다. 다시 로그인하세요.' }, 401);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now(), user.id)
    .run();
  await logActivity(env, user.id, 'login');
  return json({ token: rawToken, user: { id: user.id, username: user.username } });
}

async function adminLogin(request, env) {
  const input = await readJson(request);
  const attempt = await beginLoginAttempt(request, env, 'admin', 'admin');
  if (attempt.response) return attempt.response;

  const passwordMatches = await fixedTimeTextEqual(
    String(input.password || ''),
    String(env.ADMIN_PASSWORD || ''),
  );
  if (!env.ADMIN_PASSWORD || !passwordMatches) {
    const locked = await recordLoginFailure(env, attempt);
    if (locked) return locked;
    return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
  }
  await clearLoginFailures(env, attempt);
  return json({ token: await issueSession(env, null, 'admin', request) });
}

async function ingestTokenMatches(request, expectedValue) {
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const expected = String(expectedValue || '');
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', ingestTokenEncoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', ingestTokenEncoder.encode(expected)),
  ]);
  const matches = fixedTimeEqual(new Uint8Array(suppliedHash), new Uint8Array(expectedHash));
  return Boolean(supplied && expected && matches);
}

function behaviorOwnerUsername(env) {
  const username = String(env.BEHAVIOR_OWNER_USERNAME || '').normalize('NFKC').trim().toLowerCase();
  return username && username.length <= 80 && !username.includes(',') ? username : '';
}

function isBehaviorOwnerSession(session, env) {
  const username = String(session?.username || '').normalize('NFKC').trim().toLowerCase();
  const expected = behaviorOwnerUsername(env);
  return Boolean(username && expected && username === expected);
}

async function behaviorOwner(request, env) {
  const session = await authenticate(request, env);
  if (!session) {
    return { response: json({ error: '로그인이 필요합니다.' }, 401, { 'cache-control': 'private, no-store' }) };
  }
  if (!isBehaviorOwnerSession(session, env)) {
    return { response: json({ error: 'Not found' }, 404, { 'cache-control': 'private, no-store' }) };
  }
  return { session, response: null };
}

function boundedPaperNumber(value, minimum, maximum, integer = false) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    && (!integer || Number.isInteger(value))
    ? value
    : null;
}

function boundedPaperText(value, maximum, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
  return (!normalized && required) || normalized.length > maximum ? null : normalized;
}

function normalizePaperTimestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  const text = boundedPaperText(value, 40, true);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

// Detail keys come from the simulator, but they are still untrusted ingest data. Split camelCase,
// snake_case and environment-style aliases into the same small token vocabulary before deciding
// whether a key could carry exchange credentials or private account/order identifiers.
function normalizePaperIdentifierTokens(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 96) return null;
  const separated = value.normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/[^A-Za-z0-9]+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!separated) return null;
  const tokens = separated.split(/\s+/u);
  return separated.length <= 96 && tokens.length <= 12 && tokens.every((token) => token.length <= 48)
    ? tokens
    : null;
}

function isForbiddenPaperPrivateKey(value) {
  const tokens = normalizePaperIdentifierTokens(value);
  if (!tokens) return true;
  const compact = tokens.join('');
  if (FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_ALIASES.has(compact)) return true;
  if (FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_SUFFIXES.some((alias) => compact.endsWith(alias))) return true;
  if (tokens.some((token) => FORBIDDEN_BEHAVIOR_PAPER_CREDENTIAL_TOKENS.has(token))) return true;
  if (tokens.includes('key')
    && tokens.some((token) => ['api', 'access', 'private', 'auth', 'signing', 'exchange'].includes(token))) return true;
  if (tokens.includes('sign')
    && tokens.some((token) => ['api', 'access', 'private', 'auth', 'exchange', 'bitget'].includes(token))) return true;
  if (tokens.some((token) => ['id', 'oid', 'uid', 'uuid', 'number', 'no'].includes(token))
    && tokens.some((token) => [
      'account', 'subaccount', 'sub', 'user', 'client', 'order', 'trade', 'fill', 'position',
    ].includes(token))) return true;
  return tokens.includes('private')
    && tokens.some((token) => ['field', 'data', 'route', 'channel', 'account', 'order'].includes(token));
}

function containsForbiddenPaperPrivateAssignment(value) {
  let assignments = 0;
  const assignmentPattern = /(?:^|[^A-Za-z0-9])((?:[A-Za-z][A-Za-z0-9]{0,47})(?:(?:[-_.]|\s+)[A-Za-z][A-Za-z0-9]{0,47}){0,7})\s*(?:=|:)\s*\S+/gu;
  for (const match of value.matchAll(assignmentPattern)) {
    assignments += 1;
    if (assignments > 24 || isForbiddenPaperPrivateKey(match[1])) return true;
  }
  return false;
}

// Scan identifier-shaped fragments independently of assignment syntax. This catches quoted or
// nested-looking JSON keys even when an allowed outer assignment would otherwise consume the text.
function containsForbiddenPaperPrivateIdentifier(value) {
  let identifiers = 0;
  const recent = [];
  const identifierPattern = /[A-Za-z][A-Za-z0-9]*(?:(?:[-_./])[A-Za-z0-9]+)*/gu;
  for (const match of value.matchAll(identifierPattern)) {
    identifiers += 1;
    if (identifiers > 64 || match[0].length > 96 || isForbiddenPaperPrivateKey(match[0])) return true;
    recent.push(match[0]);
    if (recent.length > 3) recent.shift();
    for (let width = 2; width <= recent.length; width += 1) {
      const combined = recent.slice(-width).join('_');
      if (combined.length <= 96 && isForbiddenPaperPrivateKey(combined)) return true;
    }
  }
  return false;
}

// Trade and position details are display-only and versioned by the local simulator. Preserve safe,
// bounded scalar fields without allowing arbitrary depth or non-finite JSON values into D1.
function normalizePaperDetail(value, { maxKeys = 32, maxString = 240 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxKeys) return null;
  const normalized = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(key)) return null;
    if (isForbiddenPaperPrivateKey(key)) return null;
    if (item === null || typeof item === 'boolean') {
      normalized[key] = item;
    } else if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1_000_000_000_000) {
      normalized[key] = item;
    } else if (typeof item === 'string') {
      const text = boundedPaperText(item, maxString);
      if (text === null || containsForbiddenPaperPrivateText(text)) return null;
      normalized[key] = text;
    } else {
      return null;
    }
  }
  return normalized;
}

function normalizePaperLogs(value) {
  if (!Array.isArray(value) || value.length > MAX_BEHAVIOR_PAPER_LOGS) return null;
  const logs = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const message = boundedPaperText(entry, 500, true);
      if (!message || containsForbiddenPaperPrivateText(message)) return null;
      logs.push({ message });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entries = Object.entries(entry);
    if (entries.length > 12) return null;
    const normalized = normalizePaperDetail(
      Object.fromEntries(entries.filter(([key]) => key !== 'type')),
      { maxKeys: 12, maxString: 500 },
    );
    if (normalized === null) return null;
    if (!Object.prototype.hasOwnProperty.call(entry, 'type')) {
      logs.push(normalized);
      continue;
    }
    // Event type is a closed engine enum; every other log field stays on the private-text scanner above.
    const type = boundedPaperText(entry.type, 32, true);
    if (!VALID_BEHAVIOR_PAPER_LOG_TYPES.has(type)) return null;
    logs.push(Object.fromEntries(entries.map(([key]) => [key, key === 'type' ? type : normalized[key]])));
  }
  return logs;
}

function normalizePaperLimitations(value) {
  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 12) return null;
  const normalized = entries.map((entry) => boundedPaperText(entry, 400, true));
  return normalized.some((entry) => entry === null || containsForbiddenPaperPrivateText(entry)) ? null : normalized;
}

function normalizeAdaptiveStrategyId(value, nullable = false) {
  if (nullable && value === null) return null;
  const text = boundedPaperText(value, 64, true);
  return typeof text === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/u.test(text) ? text : undefined;
}

function normalizeAdaptiveHash(value, allowGenesis = false) {
  const text = boundedPaperText(value, 64, true);
  if (allowGenesis && text === 'GENESIS') return text;
  return text && /^[a-f0-9]{64}$/u.test(text) ? text : undefined;
}

function normalizeAdaptiveStrategy(value, metrics = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeAdaptiveStrategyId(value.id);
  const version = boundedPaperNumber(value.version, 1, 1_000_000, true);
  const hash = normalizeAdaptiveHash(value.hash);
  if (!id || version === null || !hash) return null;
  if (!metrics) return { id, version, hash };
  const tradeCount = boundedPaperNumber(value.trade_count, 0, 1_000_000, true);
  const expectancy = boundedPaperNumber(value.expectancy, -1_000_000, 1_000_000);
  const maxDrawdownPct = boundedPaperNumber(value.max_drawdown_pct, 0, 100);
  const costBps = boundedPaperNumber(value.cost_bps, 0, 1_000_000);
  if ([tradeCount, expectancy, maxDrawdownPct, costBps].some((item) => item === null)) return null;
  return { id, version, hash, trade_count: tradeCount, expectancy, max_drawdown_pct: maxDrawdownPct, cost_bps: costBps };
}

function normalizeAdaptiveAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sequence = boundedPaperNumber(value.sequence, 0, 100_000_000, true);
  const hash = normalizeAdaptiveHash(value.hash, sequence === 0);
  if (sequence === null || !hash || (sequence === 0 && hash !== 'GENESIS')) return null;
  if (!Array.isArray(value.recent) || value.recent.length > MAX_BEHAVIOR_ADAPTIVE_AUDIT_LOGS) return null;
  const recent = [];
  let previousSequence = 0;
  for (const entry of value.recent) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entrySequence = boundedPaperNumber(entry.sequence, 1, 100_000_000, true);
    const at = normalizePaperTimestamp(entry.at);
    const kind = boundedPaperText(entry.kind, 40, true);
    const producerMessage = boundedPaperText(entry.message, 240, true);
    const entryHash = normalizeAdaptiveHash(entry.hash);
    if (entrySequence === null || entrySequence <= previousSequence || entrySequence > sequence
      || !at || !kind || !VALID_BEHAVIOR_ADAPTIVE_AUDIT_KINDS.has(kind) || !producerMessage || !entryHash) return null;
    recent.push({ sequence: entrySequence, at, kind, message: kind, hash: entryHash });
    previousSequence = entrySequence;
  }
  if (sequence === 0 ? recent.length !== 0
    : !recent.length || recent.at(-1).sequence !== sequence || recent.at(-1).hash !== hash) return null;
  return { sequence, hash, recent };
}

function normalizeBehaviorPaperAdaptive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.engine_version !== 'realtime-paper-v2' || value.strategy_schema !== 1) return null;
  const upgradedAt = normalizePaperTimestamp(value.upgraded_at);
  const cadence = value.cadence;
  if (!upgradedAt || !cadence || typeof cadence !== 'object' || Array.isArray(cadence)
    || cadence.regime !== '5m' || cadence.candidate !== 'completed-1m' || cadence.risk !== 'ticker-event'
    || cadence.microstructure !== '1s/3s-persistence' || cadence.weight_checkpoint !== '15m'
    || cadence.challenger_checkpoint !== '24h-minimum') return null;

  const stream = value.stream;
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) return null;
  const streamStatus = boundedPaperText(stream.status, 16, true);
  const lastPacketAt = normalizePaperTimestamp(stream.last_packet_at, true);
  const reconnectCount = boundedPaperNumber(stream.reconnect_count, 0, 1_000_000, true);
  if (!streamStatus || !VALID_BEHAVIOR_ADAPTIVE_STREAM_STATUSES.has(streamStatus)
    || lastPacketAt === undefined || reconnectCount === null || stream.credential_used !== false) return null;

  const champion = normalizeAdaptiveStrategy(value.champion);
  if (!champion || !Array.isArray(value.challengers)
    || value.challengers.length > MAX_BEHAVIOR_ADAPTIVE_CHALLENGERS) return null;
  const challengers = value.challengers.map((entry) => normalizeAdaptiveStrategy(entry, true));
  if (challengers.some((entry) => entry === null)) return null;
  const strategyIds = [champion.id, ...challengers.map((entry) => entry.id)];
  if (new Set(strategyIds).size !== strategyIds.length) return null;

  const promotion = value.promotion;
  if (!promotion || typeof promotion !== 'object' || Array.isArray(promotion)) return null;
  const promotionStatus = boundedPaperText(promotion.status, 16, true);
  const checkpointAt = normalizePaperTimestamp(promotion.last_checkpoint_at, true);
  const from = normalizeAdaptiveStrategyId(promotion.from, true);
  const to = normalizeAdaptiveStrategyId(promotion.to, true);
  if (!promotionStatus || !VALID_BEHAVIOR_ADAPTIVE_PROMOTION_STATUSES.has(promotionStatus)
    || checkpointAt === undefined || from === undefined || to === undefined
    || !Array.isArray(promotion.reasons) || promotion.reasons.length < 1 || promotion.reasons.length > 12) return null;
  const reasons = promotion.reasons.map((reason) => boundedPaperText(reason, 160, true));
  if (reasons.some((reason) => reason === null || !VALID_BEHAVIOR_ADAPTIVE_PROMOTION_REASONS.has(reason))) return null;
  if (promotionStatus === 'collecting' && (checkpointAt !== null || from !== null || to !== null)) return null;
  if (promotionStatus !== 'collecting' && checkpointAt === null) return null;
  if (['promoted', 'rolled-back'].includes(promotionStatus) && (!from || !to || from === to)) return null;

  const audit = normalizeAdaptiveAudit(value.audit);
  if (!audit) return null;
  return {
    engine_version: 'realtime-paper-v2',
    strategy_schema: 1,
    upgraded_at: upgradedAt,
    cadence: {
      regime: '5m', candidate: 'completed-1m', risk: 'ticker-event', microstructure: '1s/3s-persistence',
      weight_checkpoint: '15m', challenger_checkpoint: '24h-minimum',
    },
    stream: { status: streamStatus, last_packet_at: lastPacketAt, reconnect_count: reconnectCount, credential_used: false },
    champion,
    challengers,
    promotion: { status: promotionStatus, last_checkpoint_at: checkpointAt, from, to, reasons },
    audit,
  };
}

export function normalizeBehaviorPaperReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.session_id !== BEHAVIOR_PAPER_SESSION_ID || input.simulation !== true) return null;
  const deadlineAt = normalizePaperTimestamp(input.deadline_at);
  if (deadlineAt !== BEHAVIOR_PAPER_DEADLINE) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const lastCycleAt = normalizePaperTimestamp(input.last_cycle_at, true);
  if (!generatedAt || lastCycleAt === undefined) return null;
  const status = boundedPaperText(input.status, 16, true);
  if (!VALID_BEHAVIOR_PAPER_STATUSES.has(status)) return null;

  const sequence = boundedPaperNumber(input.sequence, 1, MAX_BEHAVIOR_PAPER_SEQUENCE, true);
  const seedEquity = boundedPaperNumber(input.seed_equity, 100, 100);
  const equity = boundedPaperNumber(input.equity, 0, 1_000_000);
  const cash = boundedPaperNumber(input.cash, 0, 1_000_000);
  const realizedPnl = boundedPaperNumber(input.realized_pnl, -1_000_000, 1_000_000);
  const unrealizedPnl = boundedPaperNumber(input.unrealized_pnl, -1_000_000, 1_000_000);
  const netPnl = boundedPaperNumber(input.net_pnl, -1_000_000, 1_000_000);
  const returnPct = boundedPaperNumber(input.return_pct, -100, 1_000_000);
  const maxDrawdownPct = boundedPaperNumber(input.max_drawdown_pct, 0, 100);
  const fees = boundedPaperNumber(input.fees, 0, 1_000_000);
  const slippageCost = boundedPaperNumber(input.slippage_cost, 0, 1_000_000);
  const tradeCount = boundedPaperNumber(input.trade_count, 0, 10_000, true);
  const winCount = boundedPaperNumber(input.win_count, 0, 10_000, true);
  const lossCount = boundedPaperNumber(input.loss_count, 0, 10_000, true);
  const numbers = [sequence, seedEquity, equity, cash, realizedPnl, unrealizedPnl, netPnl,
    returnPct, maxDrawdownPct, fees, slippageCost, tradeCount, winCount, lossCount];
  if (numbers.some((value) => value === null) || winCount + lossCount > tradeCount) return null;

  let openPosition = null;
  if (input.open_position !== null) {
    openPosition = normalizePaperDetail(input.open_position);
    const symbol = openPosition?.symbol;
    const direction = openPosition?.direction ?? openPosition?.side;
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(symbol)
      || !['long', 'short'].includes(direction)) return null;
  }
  if (!Array.isArray(input.recent_trades) || input.recent_trades.length > MAX_BEHAVIOR_PAPER_TRADES) return null;
  const recentTrades = input.recent_trades.map((trade) => normalizePaperDetail(trade));
  if (recentTrades.some((trade) => trade === null)) return null;
  const recentLogs = normalizePaperLogs(input.recent_logs);
  const limitations = normalizePaperLimitations(input.limitations);
  if (!recentLogs || !limitations) return null;
  let adaptive;
  if (Object.prototype.hasOwnProperty.call(input, 'adaptive')) {
    adaptive = normalizeBehaviorPaperAdaptive(input.adaptive);
    if (!adaptive || Date.parse(adaptive.upgraded_at) > Date.parse(generatedAt)
      || (adaptive.stream.last_packet_at && Date.parse(adaptive.stream.last_packet_at) > Date.parse(generatedAt))) return null;
  }

  return {
    session_id: BEHAVIOR_PAPER_SESSION_ID,
    sequence,
    generated_at: generatedAt,
    deadline_at: BEHAVIOR_PAPER_DEADLINE,
    status,
    simulation: true,
    seed_equity: seedEquity,
    equity,
    cash,
    realized_pnl: realizedPnl,
    unrealized_pnl: unrealizedPnl,
    net_pnl: netPnl,
    return_pct: returnPct,
    max_drawdown_pct: maxDrawdownPct,
    fees,
    slippage_cost: slippageCost,
    trade_count: tradeCount,
    win_count: winCount,
    loss_count: lossCount,
    open_position: openPosition,
    recent_trades: recentTrades,
    recent_logs: recentLogs,
    last_cycle_at: lastCycleAt,
    limitations,
    ...(adaptive ? { adaptive } : {}),
  };
}

function exactPaperKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}

function normalizedExperimentHash(value, allowGenesis = false) {
  const text = boundedPaperText(value, 64, true);
  return allowGenesis && text === 'GENESIS' ? text : text && /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function normalizeExperimentDetail(value, keys) {
  if (!exactPaperKeys(value, keys)) return null;
  const normalized = normalizePaperDetail(value, { maxKeys: keys.length, maxString: 240 });
  return normalized && exactPaperKeys(normalized, keys) ? normalized : null;
}

function normalizeExperimentPosition(value) {
  if (value === null) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'entry_price', 'mark_price', 'quantity', 'notional',
    'unrealized_pnl', 'stop_price', 'target_price'];
  const result = normalizeExperimentDetail(value, keys);
  if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
    || !['long', 'short'].includes(result.direction) || !normalizePaperTimestamp(result.opened_at)) return undefined;
  return result;
}

function normalizeExperimentTrades(value) {
  if (!Array.isArray(value) || value.length > 25) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'closed_at', 'entry_price', 'exit_price', 'quantity',
    'notional', 'net_pnl', 'return_pct', 'fees', 'slippage_cost', 'reason'];
  const trades = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (trades.some((entry) => !entry || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
    || !['long', 'short'].includes(entry.direction) || !normalizePaperTimestamp(entry.opened_at)
    || !normalizePaperTimestamp(entry.closed_at))) return null;
  return trades;
}

function normalizeExperimentDecisions(value, sharedSequence) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const keys = ['symbol', 'signal_bar_at', 'observed_at', 'direction', 'score', 'confidence', 'reason', 'feed_sequence', 'feed_hash'];
  const decisions = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, keys)) return null;
    const signalBarAt = normalizePaperTimestamp(entry.signal_bar_at);
    const observedAt = normalizePaperTimestamp(entry.observed_at);
    const score = boundedPaperNumber(entry.score, -1, 1);
    const confidence = boundedPaperNumber(entry.confidence, 0, 100, true);
    const feedSequence = boundedPaperNumber(entry.feed_sequence, 1, sharedSequence, true);
    const feedHash = normalizedExperimentHash(entry.feed_hash);
    const reason = entry.reason === null ? null : boundedPaperText(entry.reason, 160, true);
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
      || !['long', 'short', 'stand-aside'].includes(entry.direction) || !signalBarAt || !observedAt
      || score === null || confidence === null || feedSequence === null || !feedHash
      || (reason !== null && containsForbiddenPaperPrivateText(reason))) return null;
    decisions.push({ symbol: entry.symbol, signal_bar_at: signalBarAt, observed_at: observedAt,
      direction: entry.direction, score, confidence, reason, feed_sequence: feedSequence, feed_hash: feedHash });
  }
  return decisions;
}

function normalizeExperimentLogs(value) {
  if (!Array.isArray(value) || value.length > 30) return null;
  const keys = ['sequence', 'at', 'type', 'message'];
  const logs = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (logs.some((entry) => !entry || boundedPaperNumber(entry.sequence, 1, 1_000_000, true) === null
    || !normalizePaperTimestamp(entry.at) || !VALID_ABC_EVENT_TYPES.has(entry.type)
    || boundedPaperText(entry.message, 240, true) === null || containsForbiddenPaperPrivateText(entry.message))) return null;
  return logs;
}

function normalizeExperimentEquityCurve(value, chainSequence, finalEquity) {
  if (!Array.isArray(value) || value.length > MAX_ABC_EQUITY_CURVE_POINTS) return null;
  const points = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, ['sequence', 'at', 'equity', 'net_pnl'])) return null;
    const sequence = boundedPaperNumber(entry.sequence, 1, chainSequence, true);
    const at = normalizePaperTimestamp(entry.at);
    const equity = boundedPaperNumber(entry.equity, 0, 1_000_000);
    const netPnl = boundedPaperNumber(entry.net_pnl, -100, 999_900);
    const previous = points.at(-1);
    if (sequence === null || !at || equity === null || netPnl === null
      || Math.abs(netPnl - (equity - 100)) > 1e-6
      || (previous && (sequence <= previous.sequence || Date.parse(at) <= Date.parse(previous.at)))) return null;
    points.push({ sequence, at, equity, net_pnl: netPnl });
  }
  if (points.length && (points.at(-1).sequence !== chainSequence || Math.abs(points.at(-1).equity - finalEquity) > 1e-6)) return null;
  return points;
}

function normalizeExperimentArm(value, armId, sharedSequence) {
  const legacyKeys = ['arm_id', 'strategy', 'chain', 'status', 'seed_equity', 'equity', 'cash', 'realized_pnl',
    'unrealized_pnl', 'net_pnl', 'return_pct', 'max_drawdown_pct', 'fees', 'slippage_cost', 'trade_count',
    'win_count', 'loss_count', 'open_position', 'recent_trades', 'recent_decisions', 'recent_logs', 'last_cycle_at'];
  const hasEquityCurve = exactPaperKeys(value, [...legacyKeys, 'equity_curve']);
  if ((!hasEquityCurve && !exactPaperKeys(value, legacyKeys)) || value.arm_id !== armId
    || !exactPaperKeys(value.strategy, ['id', 'label', 'definition_hash'])
    || value.strategy.id !== ABC_STRATEGY_IDS[armId] || value.strategy.label !== ABC_STRATEGY_LABELS[armId]
    || !normalizedExperimentHash(value.strategy.definition_hash)
    || !exactPaperKeys(value.chain, ['sequence', 'hash'])) return null;
  const chainSequence = boundedPaperNumber(value.chain.sequence, 1, 1_000_000, true);
  const chainHash = normalizedExperimentHash(value.chain.hash);
  const status = boundedPaperText(value.status, 16, true);
  const numbers = {
    seed_equity: boundedPaperNumber(value.seed_equity, 100, 100),
    equity: boundedPaperNumber(value.equity, 0, 1_000_000), cash: boundedPaperNumber(value.cash, 0, 1_000_000),
    realized_pnl: boundedPaperNumber(value.realized_pnl, -1_000_000, 1_000_000),
    unrealized_pnl: boundedPaperNumber(value.unrealized_pnl, -1_000_000, 1_000_000),
    net_pnl: boundedPaperNumber(value.net_pnl, -100, 999_900), return_pct: boundedPaperNumber(value.return_pct, -100, 999_900),
    max_drawdown_pct: boundedPaperNumber(value.max_drawdown_pct, 0, 100), fees: boundedPaperNumber(value.fees, 0, 1_000_000),
    slippage_cost: boundedPaperNumber(value.slippage_cost, 0, 1_000_000),
    trade_count: boundedPaperNumber(value.trade_count, 0, 10_000, true), win_count: boundedPaperNumber(value.win_count, 0, 10_000, true),
    loss_count: boundedPaperNumber(value.loss_count, 0, 10_000, true),
  };
  if (chainSequence === null || chainSequence > sharedSequence || !chainHash
    || !['starting', 'active', 'halted', 'complete', 'error'].includes(status)
    || Object.values(numbers).some((entry) => entry === null)
    || Math.abs(numbers.net_pnl - (numbers.equity - 100)) > 1e-6
    || Math.abs(numbers.return_pct - numbers.net_pnl) > 1e-6
    || numbers.win_count + numbers.loss_count > numbers.trade_count) return null;
  const openPosition = normalizeExperimentPosition(value.open_position);
  const trades = normalizeExperimentTrades(value.recent_trades);
  const decisions = normalizeExperimentDecisions(value.recent_decisions, sharedSequence);
  const logs = normalizeExperimentLogs(value.recent_logs);
  const equityCurve = hasEquityCurve ? normalizeExperimentEquityCurve(value.equity_curve, chainSequence, numbers.equity) : [];
  const lastCycleAt = normalizePaperTimestamp(value.last_cycle_at, true);
  if (openPosition === undefined || !trades || !decisions || !logs || !equityCurve || lastCycleAt === undefined) return null;
  return { arm_id: armId, strategy: { id: ABC_STRATEGY_IDS[armId], label: ABC_STRATEGY_LABELS[armId],
    definition_hash: value.strategy.definition_hash }, chain: { sequence: chainSequence, hash: chainHash }, status,
    ...numbers, equity_curve: equityCurve, open_position: openPosition, recent_trades: trades, recent_decisions: decisions, recent_logs: logs,
    last_cycle_at: lastCycleAt };
}

export function normalizeBehaviorPaperExperimentReport(input) {
  const keys = ['schema', 'experiment_id', 'simulation', 'public_data_only', 'generated_at', 'started_at', 'deadline_at',
    'status', 'shared_feed', 'assumptions', 'leaderboard', 'arms', 'limitations'];
  if (!exactPaperKeys(input, keys) || input.schema !== 'abc-paper-experiment-v1'
    || input.experiment_id !== BEHAVIOR_ABC_EXPERIMENT_ID || input.simulation !== true || input.public_data_only !== true) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const startedAt = normalizePaperTimestamp(input.started_at);
  const deadlineAt = normalizePaperTimestamp(input.deadline_at);
  const status = boundedPaperText(input.status, 16, true);
  if (!generatedAt || !startedAt || !deadlineAt || Date.parse(deadlineAt) - Date.parse(startedAt) !== DAY_MS
    || Date.parse(generatedAt) < Date.parse(startedAt) || Date.parse(generatedAt) > Date.parse(deadlineAt) + 60 * 60_000
    || !['starting', 'active', 'complete', 'error'].includes(status)) return null;
  const feedKeys = ['sequence', 'hash', 'last_packet_at', 'credential_used', 'symbols', 'channels'];
  if (!exactPaperKeys(input.shared_feed, feedKeys)) return null;
  const sharedSequence = boundedPaperNumber(input.shared_feed.sequence, 1, 100_000_000, true);
  const sharedHash = normalizedExperimentHash(input.shared_feed.hash);
  const lastPacketAt = normalizePaperTimestamp(input.shared_feed.last_packet_at, true);
  if (sharedSequence === null || !sharedHash || lastPacketAt === undefined || input.shared_feed.credential_used !== false
    || JSON.stringify(input.shared_feed.symbols) !== JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    || JSON.stringify(input.shared_feed.channels) !== JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
    || (lastPacketAt && Date.parse(lastPacketAt) > Date.parse(generatedAt))) return null;
  const assumptionKeys = ['seed_equity_per_arm', 'fee_bps_per_side', 'slippage_bps_per_side', 'risk_pct', 'leverage_cap',
    'drawdown_halt_pct', 'entry_cutoff_at', 'terminal_close', 'max_positions_per_arm', 'strategy_mutation'];
  if (!exactPaperKeys(input.assumptions, assumptionKeys)
    || input.assumptions.seed_equity_per_arm !== 100 || input.assumptions.fee_bps_per_side !== 6
    || input.assumptions.slippage_bps_per_side !== 4 || input.assumptions.risk_pct !== 5
    || input.assumptions.leverage_cap !== 10 || input.assumptions.drawdown_halt_pct !== 20
    || normalizePaperTimestamp(input.assumptions.entry_cutoff_at) !== new Date(Date.parse(deadlineAt) - 15 * 60_000).toISOString()
    || input.assumptions.terminal_close !== 'deadline' || input.assumptions.max_positions_per_arm !== 1
    || input.assumptions.strategy_mutation !== false) return null;
  if (!Array.isArray(input.arms) || input.arms.length !== 3) return null;
  const arms = input.arms.map((arm, index) => normalizeExperimentArm(arm, ABC_ARM_IDS[index], sharedSequence));
  if (arms.some((arm) => !arm) || new Set(arms.map((arm) => arm.chain.hash)).size !== 3) return null;
  if (!Array.isArray(input.leaderboard) || input.leaderboard.length !== 3) return null;
  const expectedLeaderboard = [...arms].sort((left, right) => right.equity - left.equity || left.arm_id.localeCompare(right.arm_id));
  const leaderboard = input.leaderboard.map((row, index) => {
    if (!exactPaperKeys(row, ['rank', 'arm_id', 'equity', 'net_pnl', 'return_pct', 'max_drawdown_pct'])) return null;
    const arm = expectedLeaderboard[index];
    return row.rank === index + 1 && row.arm_id === arm.arm_id && ['equity', 'net_pnl', 'return_pct', 'max_drawdown_pct']
      .every((key) => row[key] === arm[key]) ? { ...row } : null;
  });
  const limitations = normalizePaperLimitations(input.limitations);
  if (leaderboard.some((row) => !row) || !limitations) return null;
  return { schema: 'abc-paper-experiment-v1', experiment_id: BEHAVIOR_ABC_EXPERIMENT_ID, simulation: true,
    public_data_only: true, generated_at: generatedAt, started_at: startedAt, deadline_at: deadlineAt, status,
    shared_feed: { sequence: sharedSequence, hash: sharedHash, last_packet_at: lastPacketAt, credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { ...input.assumptions, entry_cutoff_at: normalizePaperTimestamp(input.assumptions.entry_cutoff_at) },
    leaderboard, arms, limitations };
}

function closePaperNumber(left, right) {
  return Math.abs(left - right) <= Math.max(1e-6, Math.max(Math.abs(left), Math.abs(right)) * 1e-9);
}

function normalizeMultiPosition(value, startedAtMs, latestAtMs) {
  if (value === null) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'entry_price', 'mark_price', 'quantity', 'notional',
    'leverage', 'unrealized_pnl', 'stop_price', 'target_price'];
  const result = normalizeExperimentDetail(value, keys);
  const openedAt = result && normalizePaperTimestamp(result.opened_at);
  const numbers = result && {
    entry_price: boundedPaperNumber(result.entry_price, 0, 1_000_000_000),
    mark_price: boundedPaperNumber(result.mark_price, 0, 1_000_000_000),
    quantity: boundedPaperNumber(result.quantity, 0, 1_000_000_000),
    notional: boundedPaperNumber(result.notional, 0, 1_000_000_000),
    leverage: boundedPaperNumber(result.leverage, 0, 3),
    unrealized_pnl: boundedPaperNumber(result.unrealized_pnl, -1_000_000, 1_000_000),
    stop_price: boundedPaperNumber(result.stop_price, 0, 1_000_000_000),
    target_price: boundedPaperNumber(result.target_price, 0, 1_000_000_000),
  };
  const sign = result?.direction === 'long' ? 1 : -1;
  const modeledExitPrice = numbers && numbers.mark_price * (1 - sign * MULTI_ADVERSE_SLIPPAGE_RATE);
  const modeledExitFee = numbers && numbers.quantity * modeledExitPrice * MULTI_FEE_RATE;
  const expectedUnrealizedPnl = numbers && sign * numbers.quantity
    * (modeledExitPrice - numbers.entry_price) - modeledExitFee;
  if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
    || !['long', 'short'].includes(result.direction) || !openedAt
    || Object.values(numbers).some((entry) => entry === null)
    || ['entry_price', 'mark_price', 'quantity', 'notional', 'leverage', 'stop_price', 'target_price']
      .some((key) => numbers[key] <= 0)
    || Date.parse(openedAt) < startedAtMs || Date.parse(openedAt) > latestAtMs
    || !closePaperNumber(numbers.notional, numbers.entry_price * numbers.quantity)
    || !closePaperNumber(numbers.unrealized_pnl, expectedUnrealizedPnl)
    || (result.direction === 'long'
      ? !(numbers.stop_price < numbers.entry_price && numbers.entry_price < numbers.target_price)
      : !(numbers.target_price < numbers.entry_price && numbers.entry_price < numbers.stop_price))) return undefined;
  return { id: result.id, symbol: result.symbol, direction: result.direction, opened_at: openedAt, ...numbers };
}

function normalizeMultiTrades(value, startedAtMs, latestAtMs, terminalClose) {
  if (!Array.isArray(value) || value.length > 25) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'closed_at', 'entry_price', 'exit_price', 'quantity',
    'notional', 'net_pnl', 'return_pct', 'fees', 'slippage_cost', 'reason'];
  const trades = [];
  for (const entry of value) {
    const result = normalizeExperimentDetail(entry, keys);
    const openedAt = result && normalizePaperTimestamp(result.opened_at);
    const closedAt = result && normalizePaperTimestamp(result.closed_at);
    const numbers = result && {
      entry_price: boundedPaperNumber(result.entry_price, 0, 1_000_000_000),
      exit_price: boundedPaperNumber(result.exit_price, 0, 1_000_000_000),
      quantity: boundedPaperNumber(result.quantity, 0, 1_000_000_000),
      notional: boundedPaperNumber(result.notional, 0, 1_000_000_000),
      net_pnl: boundedPaperNumber(result.net_pnl, -1_000_000, 1_000_000),
      return_pct: boundedPaperNumber(result.return_pct, -1_000_000, 1_000_000),
      fees: boundedPaperNumber(result.fees, 0, 1_000_000),
      slippage_cost: boundedPaperNumber(result.slippage_cost, 0, 1_000_000),
    };
    if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
      || !['long', 'short'].includes(result.direction) || !openedAt || !closedAt
      || Object.values(numbers).some((item) => item === null)
      || ['entry_price', 'exit_price', 'quantity', 'notional'].some((key) => numbers[key] <= 0)
      || Date.parse(openedAt) < startedAtMs || Date.parse(closedAt) < Date.parse(openedAt)
      || Date.parse(closedAt) > latestAtMs || !closePaperNumber(numbers.notional, numbers.entry_price * numbers.quantity)
      || !closePaperNumber(numbers.fees,
        numbers.quantity * (numbers.entry_price + numbers.exit_price) * MULTI_FEE_RATE)
      || !closePaperNumber(numbers.net_pnl, (result.direction === 'long' ? 1 : -1)
        * numbers.quantity * (numbers.exit_price - numbers.entry_price) - numbers.fees)
      || !closePaperNumber(numbers.return_pct, numbers.net_pnl / numbers.notional * 100)
      || !['stop', 'target', 'opposite-signal', 'max-hold', 'risk-halt', terminalClose].includes(result.reason)) return null;
    trades.push({ id: result.id, symbol: result.symbol, direction: result.direction,
      opened_at: openedAt, closed_at: closedAt, ...numbers, reason: result.reason });
  }
  return trades;
}

function normalizeMultiDecisions(value, sharedSequence, startedAtMs, latestAtMs) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const keys = ['symbol', 'signal_bar_at', 'observed_at', 'regime', 'direction', 'score', 'confidence',
    'spread_bps', 'feature_agreement', 'target_distance_bps', 'net_reward_risk', 'gate_reasons',
    'feed_sequence', 'feed_hash'];
  const decisions = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, keys)) return null;
    const signalBarAt = normalizePaperTimestamp(entry.signal_bar_at);
    const observedAt = normalizePaperTimestamp(entry.observed_at);
    const score = boundedPaperNumber(entry.score, -1, 1);
    const confidence = boundedPaperNumber(entry.confidence, 0, 100, true);
    const spreadBps = boundedPaperNumber(entry.spread_bps, 0, 100);
    const featureAgreement = boundedPaperNumber(entry.feature_agreement, 0, 4, true);
    const targetDistanceBps = boundedPaperNumber(entry.target_distance_bps, 0, 10_000);
    const netRewardRisk = boundedPaperNumber(entry.net_reward_risk, 0, 100);
    const feedSequence = boundedPaperNumber(entry.feed_sequence, 1, sharedSequence, true);
    const feedHash = normalizedExperimentHash(entry.feed_hash);
    if (!Array.isArray(entry.gate_reasons) || entry.gate_reasons.length > 8) return null;
    const gateReasons = entry.gate_reasons.map((reason) => boundedPaperText(reason, 48, true));
    if (gateReasons.some((reason) => !VALID_MULTI_GATE_REASONS.has(reason))
      || new Set(gateReasons).size !== gateReasons.length) return null;
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
      || !['trend-up', 'trend-down', 'range', 'stress'].includes(entry.regime)
      || !['long', 'short', 'stand-aside'].includes(entry.direction) || !signalBarAt || !observedAt
      || Date.parse(signalBarAt) > Date.parse(observedAt) || Date.parse(observedAt) < startedAtMs
      || Date.parse(observedAt) > latestAtMs
      || [score, confidence, spreadBps, featureAgreement, targetDistanceBps, netRewardRisk, feedSequence]
        .some((item) => item === null) || !feedHash
      || (entry.direction === 'stand-aside' ? gateReasons.length < 1 : gateReasons.length !== 0)) return null;
    decisions.push({ symbol: entry.symbol, signal_bar_at: signalBarAt, observed_at: observedAt,
      regime: entry.regime, direction: entry.direction, score, confidence, spread_bps: spreadBps,
      feature_agreement: featureAgreement, target_distance_bps: targetDistanceBps,
      net_reward_risk: netRewardRisk, gate_reasons: gateReasons, feed_sequence: feedSequence, feed_hash: feedHash });
  }
  return decisions;
}

function normalizeMultiLogs(value, startedAtMs, latestAtMs) {
  if (!Array.isArray(value) || value.length > 30) return null;
  const keys = ['sequence', 'at', 'type', 'message'];
  const logs = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (logs.some((entry) => !entry || boundedPaperNumber(entry.sequence, 1, 1_000_000, true) === null
    || !normalizePaperTimestamp(entry.at) || !VALID_MULTI_EVENT_TYPES.has(entry.type)
    || Date.parse(entry.at) < startedAtMs || Date.parse(entry.at) > latestAtMs
    || boundedPaperText(entry.message, 240, true) === null || containsForbiddenPaperPrivateText(entry.message))) return null;
  return logs;
}

function normalizeMultiPolicy(value, armId) {
  const expected = MULTI_STRATEGIES[armId];
  const keys = ['style', 'allowed_regimes', 'required_features', 'minimum_feature_agreement',
    'min_persistence_seconds', 'entry_threshold', 'max_spread_bps', 'min_target_bps',
    'min_net_reward_risk', 'cooldown_minutes', 'opposite_confirmations'];
  if (!exactPaperKeys(value, keys)) return null;
  const facts = Object.fromEntries(keys.map((key) => [key, expected[key]]));
  return JSON.stringify(value) === JSON.stringify(facts) ? facts : null;
}

function normalizeMultiArm(value, armId, sharedSequence, startedAtMs, latestAtMs, terminalClose) {
  const keys = ['arm_id', 'strategy', 'risk', 'chain', 'status', 'seed_equity', 'equity', 'cash',
    'realized_pnl', 'unrealized_pnl', 'net_pnl', 'return_pct', 'max_drawdown_pct', 'fees',
    'slippage_cost', 'trade_count', 'win_count', 'loss_count', 'equity_curve', 'open_position',
    'recent_trades', 'recent_decisions', 'recent_logs', 'last_cycle_at'];
  const expected = MULTI_STRATEGIES[armId];
  if (!exactPaperKeys(value, keys) || value.arm_id !== armId
    || !exactPaperKeys(value.strategy, ['id', 'label', 'definition_hash', 'policy'])
    || value.strategy.id !== expected.id || value.strategy.label !== expected.label
    || value.strategy.definition_hash !== expected.definition_hash || !normalizeMultiPolicy(value.strategy.policy, armId)
    || !exactPaperKeys(value.risk, ['risk_pct', 'leverage_cap', 'drawdown_halt_pct', 'max_hold_minutes',
      'minimum_hold_before_opposite_minutes'])
    || JSON.stringify(value.risk) !== JSON.stringify({ risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
      max_hold_minutes: 45, minimum_hold_before_opposite_minutes: 5 })
    || !exactPaperKeys(value.chain, ['sequence', 'hash'])) return null;
  const chainSequence = boundedPaperNumber(value.chain.sequence, 1, 1_000_000_000, true);
  const chainHash = normalizedExperimentHash(value.chain.hash);
  const status = boundedPaperText(value.status, 16, true);
  const numbers = {
    seed_equity: boundedPaperNumber(value.seed_equity, 100, 100),
    equity: boundedPaperNumber(value.equity, 0, 1_000_000), cash: boundedPaperNumber(value.cash, 0, 1_000_000),
    realized_pnl: boundedPaperNumber(value.realized_pnl, -1_000_000, 1_000_000),
    unrealized_pnl: boundedPaperNumber(value.unrealized_pnl, -1_000_000, 1_000_000),
    net_pnl: boundedPaperNumber(value.net_pnl, -100, 999_900), return_pct: boundedPaperNumber(value.return_pct, -100, 999_900),
    max_drawdown_pct: boundedPaperNumber(value.max_drawdown_pct, 0, 100), fees: boundedPaperNumber(value.fees, 0, 1_000_000),
    slippage_cost: boundedPaperNumber(value.slippage_cost, 0, 1_000_000),
    trade_count: boundedPaperNumber(value.trade_count, 0, 10_000, true),
    win_count: boundedPaperNumber(value.win_count, 0, 10_000, true),
    loss_count: boundedPaperNumber(value.loss_count, 0, 10_000, true),
  };
  if (chainSequence === null || chainSequence > sharedSequence || !chainHash
    || !['starting', 'active', 'halted', 'complete', 'error'].includes(status)
    || Object.values(numbers).some((entry) => entry === null)
    || Math.abs(numbers.net_pnl - (numbers.equity - 100)) > 1e-6
    || Math.abs(numbers.return_pct - numbers.net_pnl) > 1e-6
    || numbers.win_count + numbers.loss_count > numbers.trade_count) return null;
  const equityCurve = normalizeExperimentEquityCurve(value.equity_curve, chainSequence, numbers.equity);
  const openPosition = normalizeMultiPosition(value.open_position, startedAtMs, latestAtMs);
  const trades = normalizeMultiTrades(value.recent_trades, startedAtMs, latestAtMs, terminalClose);
  const decisions = normalizeMultiDecisions(value.recent_decisions, sharedSequence, startedAtMs, latestAtMs);
  const logs = normalizeMultiLogs(value.recent_logs, startedAtMs, latestAtMs);
  const lastCycleAt = normalizePaperTimestamp(value.last_cycle_at, true);
  const startingState = status === 'starting' && openPosition === null && numbers.trade_count === 0
    && numbers.win_count === 0 && numbers.loss_count === 0 && closePaperNumber(numbers.equity, 100)
    && closePaperNumber(numbers.cash, 100) && closePaperNumber(numbers.realized_pnl, 0)
    && closePaperNumber(numbers.unrealized_pnl, 0) && closePaperNumber(numbers.fees, 0)
    && closePaperNumber(numbers.slippage_cost, 0) && decisions?.length === 0 && trades?.length === 0
    && lastCycleAt === null;
  const recentFees = trades?.reduce((sum, trade) => sum + trade.fees, 0) ?? 0;
  const recentSlippage = trades?.reduce((sum, trade) => sum + trade.slippage_cost, 0) ?? 0;
  const recentNetPnl = trades?.reduce((sum, trade) => sum + trade.net_pnl, 0) ?? 0;
  const recentWins = trades?.filter((trade) => trade.net_pnl > 0).length ?? 0;
  const recentLosses = trades?.filter((trade) => trade.net_pnl < 0).length ?? 0;
  const retainedEntryFee = openPosition === null ? 0 : numbers.fees - recentFees;
  const retainedRealizedPnl = recentNetPnl - retainedEntryFee;
  const modeledOpenEntryFee = !openPosition ? 0 : openPosition.notional * MULTI_FEE_RATE;
  const modeledPreEntryEquity = !openPosition ? 0 : numbers.cash + modeledOpenEntryFee;
  if (!equityCurve || openPosition === undefined || !trades || !decisions || !logs || lastCycleAt === undefined
    || !closePaperNumber(numbers.realized_pnl, numbers.cash - 100)
    || !closePaperNumber(numbers.equity, numbers.cash + numbers.unrealized_pnl)
    || (openPosition === null ? !closePaperNumber(numbers.unrealized_pnl, 0)
      : !closePaperNumber(openPosition.unrealized_pnl, numbers.unrealized_pnl))
    || (openPosition !== null && (!(modeledPreEntryEquity > 0)
      || !closePaperNumber(openPosition.leverage, openPosition.notional / modeledPreEntryEquity)))
    || trades.length > numbers.trade_count || numbers.fees + 1e-6 < recentFees
    || numbers.slippage_cost + 1e-6 < recentSlippage
    || recentWins > numbers.win_count || recentLosses > numbers.loss_count
    || (trades.length === numbers.trade_count && (!closePaperNumber(retainedRealizedPnl, numbers.realized_pnl)
      || (openPosition !== null && !closePaperNumber(retainedEntryFee, modeledOpenEntryFee))
      || recentWins !== numbers.win_count || recentLosses !== numbers.loss_count))
    || (status === 'starting' && !startingState) || (status !== 'starting' && lastCycleAt === null)
    || (lastCycleAt && (Date.parse(lastCycleAt) < startedAtMs || Date.parse(lastCycleAt) > latestAtMs))
    || (['complete', 'error'].includes(status) && openPosition !== null)
    || equityCurve.some((point) => Date.parse(point.at) < startedAtMs || Date.parse(point.at) > latestAtMs)) return null;
  return { arm_id: armId, strategy: { id: expected.id, label: expected.label,
    definition_hash: expected.definition_hash, policy: normalizeMultiPolicy(value.strategy.policy, armId) },
  risk: { ...value.risk }, chain: { sequence: chainSequence, hash: chainHash }, status,
  ...numbers, equity_curve: equityCurve, open_position: openPosition, recent_trades: trades,
  recent_decisions: decisions, recent_logs: logs, last_cycle_at: lastCycleAt };
}

export function normalizeBehaviorMultiPaperExperimentReport(input) {
  const fixedKeys = ['schema', 'experiment_id', 'simulation', 'public_data_only', 'generated_at', 'started_at',
    'deadline_at', 'status', 'strategy_set_hash', 'shared_feed', 'assumptions', 'leaderboard', 'arms', 'limitations'];
  const continuousKeys = [...fixedKeys, 'run_mode', 'stopped_at'];
  const continuous = input?.run_mode === 'until-stopped';
  if (!exactPaperKeys(input, continuous ? continuousKeys : fixedKeys) || input.schema !== 'multi-paper-experiment-v3'
    || input.experiment_id !== BEHAVIOR_MULTI_EXPERIMENT_ID || input.simulation !== true
    || input.public_data_only !== true || input.strategy_set_hash !== MULTI_STRATEGY_SET_HASH) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const startedAt = normalizePaperTimestamp(input.started_at);
  const deadlineAt = continuous && input.deadline_at === null ? null : normalizePaperTimestamp(input.deadline_at);
  const stoppedAt = continuous ? normalizePaperTimestamp(input.stopped_at, true) : undefined;
  const status = boundedPaperText(input.status, 16, true);
  if (!generatedAt || !startedAt || (continuous ? (deadlineAt !== null || stoppedAt === undefined
      || (status === 'complete') !== Boolean(stoppedAt)
      || (stoppedAt && stoppedAt !== generatedAt))
    : (!deadlineAt || Date.parse(deadlineAt) - Date.parse(startedAt) !== DAY_MS
      || Date.parse(generatedAt) > Date.parse(deadlineAt) + 60 * 60_000))
    || Date.parse(generatedAt) < Date.parse(startedAt)
    || !['starting', 'active', 'complete', 'error'].includes(status)) return null;
  const feedKeys = ['provider', 'sequence', 'hash', 'last_packet_at', 'credential_used', 'symbols', 'channels'];
  if (!exactPaperKeys(input.shared_feed, feedKeys)) return null;
  const sharedSequence = boundedPaperNumber(input.shared_feed.sequence, 1, 1_000_000_000, true);
  const sharedHash = normalizedExperimentHash(input.shared_feed.hash);
  const lastPacketAt = normalizePaperTimestamp(input.shared_feed.last_packet_at, true);
  if (sharedSequence === null || !sharedHash || lastPacketAt === undefined
    || input.shared_feed.provider !== 'binance-usdm-public' || input.shared_feed.credential_used !== false
    || JSON.stringify(input.shared_feed.symbols) !== JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    || JSON.stringify(input.shared_feed.channels) !== JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
    || (lastPacketAt && Date.parse(lastPacketAt) > Date.parse(generatedAt))) return null;
  const assumptions = { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4,
    modeled_round_trip_cost_bps: 20, risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
    entry_cutoff_at: continuous ? null : new Date(Date.parse(deadlineAt) - 15 * 60_000).toISOString(),
    terminal_close: continuous ? 'owner-stop' : 'deadline',
    max_positions_per_arm: 1, strategy_mutation: false };
  if (!exactPaperKeys(input.assumptions, Object.keys(assumptions))
    || JSON.stringify(input.assumptions) !== JSON.stringify(assumptions)) return null;
  if (!Array.isArray(input.arms) || input.arms.length !== 6) return null;
  const startedAtMs = Date.parse(startedAt);
  const latestAtMs = continuous ? Date.parse(generatedAt) : Math.min(Date.parse(generatedAt), Date.parse(deadlineAt));
  const arms = input.arms.map((arm, index) => normalizeMultiArm(arm, MULTI_ARM_IDS[index], sharedSequence,
    startedAtMs, latestAtMs, assumptions.terminal_close));
  if (arms.some((arm) => !arm) || new Set(arms.map((arm) => arm.chain.hash)).size !== 6) return null;
  const armStatuses = arms.map((arm) => arm.status);
  const coherentStatus = status === 'starting' ? armStatuses.every((armStatus) => armStatus === 'starting')
    : status === 'complete' ? armStatuses.every((armStatus) => armStatus === 'complete')
      : status === 'active' ? armStatuses.every((armStatus) => ['active', 'halted'].includes(armStatus))
        : status === 'error' && armStatuses.some((armStatus) => armStatus === 'error')
          && armStatuses.every((armStatus) => ['complete', 'error'].includes(armStatus));
  if (!coherentStatus) return null;
  if (!Array.isArray(input.leaderboard) || input.leaderboard.length !== 6) return null;
  const expectedLeaderboard = [...arms].sort((left, right) => right.equity - left.equity || left.arm_id.localeCompare(right.arm_id));
  const leaderboard = input.leaderboard.map((row, index) => {
    if (!exactPaperKeys(row, ['rank', 'arm_id', 'equity', 'net_pnl', 'return_pct', 'max_drawdown_pct'])) return null;
    const arm = expectedLeaderboard[index];
    return row.rank === index + 1 && row.arm_id === arm.arm_id && ['equity', 'net_pnl', 'return_pct', 'max_drawdown_pct']
      .every((key) => row[key] === arm[key]) ? { ...row } : null;
  });
  const limitations = normalizePaperLimitations(input.limitations);
  if (leaderboard.some((row) => !row) || !limitations) return null;
  return { schema: 'multi-paper-experiment-v3', experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    simulation: true, public_data_only: true, generated_at: generatedAt, started_at: startedAt,
    ...(continuous ? { run_mode: 'until-stopped', deadline_at: null, stopped_at: stoppedAt }
      : { deadline_at: deadlineAt }), status, strategy_set_hash: MULTI_STRATEGY_SET_HASH,
    shared_feed: { provider: 'binance-usdm-public', sequence: sharedSequence, hash: sharedHash, last_packet_at: lastPacketAt,
      credential_used: false, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      channels: ['ticker', 'books5', 'trade', 'candle1m'] }, assumptions, leaderboard, arms, limitations };
}

function containsForbiddenPaperPrivateText(value) {
  return /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/iu.test(value)
    || containsForbiddenPaperPrivateIdentifier(value)
    || containsForbiddenPaperPrivateAssignment(value)
    || /(?:^|[\s"'`])\/api\/[^\s"'`]*(?:account|orders?|positions?|private|trade)(?:\/|[\s"'`]|$)/iu.test(value)
    || /\bwss?:\/\/[^\s"'`]+\/private(?:\/|\b)/iu.test(value)
    || /\b(?:account[-_ ]?id|order[-_ ]?id|private[-_ ]?(?:route|field|data))\b(?:\s*(?:=|:)\s*\S+)?/iu.test(value);
}

async function readBehaviorPaperJson(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTI_PAPER_BYTES) {
    return { error: json({ error: '모의투자 보고가 너무 큽니다.' }, 413) };
  }
  const reader = request.body?.getReader();
  if (!reader) return { value: null };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTI_PAPER_BYTES) {
        await reader.cancel();
        return { error: json({ error: '모의투자 보고가 너무 큽니다.' }, 413) };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text), size };
  } catch {
    return { value: null };
  }
}

async function reportBehaviorPaper(request, env) {
  if (!(await ingestTokenMatches(request, env.BEHAVIOR_PAPER_REPORT_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }
  const body = await readBehaviorPaperJson(request);
  if (body.error) return body.error;
  if (body.value?.schema === 'multi-paper-experiment-v3') return reportBehaviorMultiPaperExperiment(body.value, body.size, env);
  if (body.value?.schema === 'abc-paper-experiment-v1') {
    if (body.size > MAX_BEHAVIOR_PAPER_BYTES) return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
    return reportBehaviorPaperExperiment(body.value, env);
  }
  if (body.size > MAX_BEHAVIOR_PAPER_BYTES) return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
  const report = normalizeBehaviorPaperReport(body.value);
  if (!report) return json({ error: '잘못된 모의투자 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
      AND (
        json_type(usage_snapshots.payload, '$.adaptive') IS NULL
        OR json_type(excluded.payload, '$.adaptive') = 'object'
      )
      AND (
        json_type(usage_snapshots.payload, '$.adaptive') IS NULL
        OR (
          CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
            >= CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER)
          AND (
            CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
              > CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER)
            OR (
              json_extract(excluded.payload, '$.adaptive.audit.hash')
                = json_extract(usage_snapshots.payload, '$.adaptive.audit.hash')
              AND json_extract(excluded.payload, '$.adaptive.audit')
                = json_extract(usage_snapshots.payload, '$.adaptive.audit')
            )
          )
        )
      )
      AND (
        CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
        OR (
          json_type(excluded.payload, '$.adaptive') = 'object'
          AND CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
            > COALESCE(CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER), -1)
        )
      )
      AND (
        CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
        OR json_remove(excluded.payload, '$.generated_at', '$.adaptive')
          = json_remove(usage_snapshots.payload, '$.generated_at', '$.adaptive')
      )
  `).bind(
    BEHAVIOR_PAPER_SNAPSHOT_SOURCE,
    receivedAt,
    JSON.stringify(report),
  ).run();
  if (inserted?.meta?.changes !== 1) {
    return json({ error: '더 최신인 보고가 이미 저장되어 있습니다.' }, 409);
  }
  return json({ ok: true, session_id: report.session_id, sequence: report.sequence });
}

function normalizeBehaviorMultiStopControl(row) {
  if (!row?.payload) return { experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    stop_requested: false, stop_requested_at: null };
  try {
    const value = JSON.parse(row.payload);
    const stoppedAt = normalizePaperTimestamp(value.stop_requested_at);
    if (!exactPaperKeys(value, ['experiment_id', 'stop_requested', 'stop_requested_at'])
      || value.experiment_id !== BEHAVIOR_MULTI_EXPERIMENT_ID || value.stop_requested !== true || !stoppedAt) return null;
    return { experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID, stop_requested: true, stop_requested_at: stoppedAt };
  } catch { return null; }
}

async function getBehaviorMultiPaperControl(request, env) {
  if (!(await ingestTokenMatches(request, env.BEHAVIOR_PAPER_REPORT_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }
  const url = new URL(request.url);
  if (url.searchParams.size !== 1 || url.searchParams.get('experiment_id') !== BEHAVIOR_MULTI_EXPERIMENT_ID) {
    return json({ error: '잘못된 모의실험 제어 요청입니다.' }, 400, { 'cache-control': 'private, no-store' });
  }
  const row = await env.DB.prepare(`
    SELECT payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_CONTROL_SOURCE).first();
  const control = normalizeBehaviorMultiStopControl(row);
  if (!control) return json({ error: '모의실험 제어 상태를 읽지 못했습니다.' }, 500,
    { 'cache-control': 'private, no-store' });
  return json(control, 200, { 'cache-control': 'private, no-store' });
}

async function stopBehaviorMultiPaper(request, env) {
  const owner = await behaviorOwner(request, env);
  if (owner.response) return owner.response;
  const input = await readJson(request);
  if (!exactPaperKeys(input, ['experiment_id']) || input.experiment_id !== BEHAVIOR_MULTI_EXPERIMENT_ID) {
    return json({ error: '잘못된 모의실험 중단 요청입니다.' }, 400, { 'cache-control': 'private, no-store' });
  }
  const activeRow = await env.DB.prepare(`
    SELECT payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_SNAPSHOT_SOURCE).first();
  let active = null;
  try { active = activeRow ? normalizeBehaviorMultiPaperExperimentReport(JSON.parse(activeRow.payload)) : null; }
  catch { active = null; }
  if (!active || !['starting', 'active'].includes(active.status) || active.run_mode !== 'until-stopped') {
    return json({ error: '중단할 수 있는 6-arm 모의실험이 없습니다.' }, 409,
      { 'cache-control': 'private, no-store' });
  }
  const stopRequestedAt = new Date().toISOString();
  const control = { experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID, stop_requested: true,
    stop_requested_at: stopRequestedAt };
  await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO NOTHING
  `).bind(BEHAVIOR_MULTI_CONTROL_SOURCE, stopRequestedAt, JSON.stringify(control)).run();
  const stored = await env.DB.prepare(`
    SELECT payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_CONTROL_SOURCE).first();
  const exact = normalizeBehaviorMultiStopControl(stored);
  if (!exact?.stop_requested) return json({ error: '모의실험 중단 요청을 저장하지 못했습니다.' }, 500,
    { 'cache-control': 'private, no-store' });
  return json({ ok: true, ...exact }, 202, { 'cache-control': 'private, no-store' });
}

async function reportBehaviorPaperExperiment(value, env) {
  const report = normalizeBehaviorPaperExperimentReport(value);
  if (!report) return json({ error: '잘못된 A/B/C 모의실험 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
      AND (
        CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
        OR excluded.payload = usage_snapshots.payload
      )
      AND (
        CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.shared_feed.hash') = json_extract(usage_snapshots.payload, '$.shared_feed.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[0].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[0].chain.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[1].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[1].chain.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[2].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[2].chain.hash')
      )
  `).bind(BEHAVIOR_ABC_SNAPSHOT_SOURCE, receivedAt, JSON.stringify(report)).run();
  if (inserted?.meta?.changes !== 1) return json({ error: '더 최신인 A/B/C 보고가 이미 저장되어 있습니다.' }, 409);
  return json({ ok: true, experiment_id: report.experiment_id, shared_feed_sequence: report.shared_feed.sequence,
    snapshot_fingerprint: await sha256(JSON.stringify(report)) });
}

async function reportBehaviorMultiPaperExperiment(value, bodySize, env) {
  if (!Number.isSafeInteger(bodySize) || bodySize < 1 || bodySize > MAX_MULTI_PAPER_BYTES) {
    return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
  }
  const report = normalizeBehaviorMultiPaperExperimentReport(value);
  if (!report) return json({ error: '잘못된 6-arm v2 모의실험 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const references = ['$.shared_feed', ...MULTI_ARM_IDS.map((_, index) => `$.arms[${index}].chain`)];
  const monotonic = references.map((path) => `
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      >= CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
  `).join(' AND ');
  const advanced = references.map((path) => `
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      > CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
  `).join(' OR ');
  const stableAtSameSequence = references.map((path) => `(
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      > CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
    OR json_extract(excluded.payload, '${path}.hash') = json_extract(usage_snapshots.payload, '${path}.hash')
  )`).join(' AND ');
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE ${monotonic}
      AND (${advanced} OR excluded.payload = usage_snapshots.payload)
      AND ${stableAtSameSequence}
  `).bind(BEHAVIOR_MULTI_SNAPSHOT_SOURCE, receivedAt, JSON.stringify(report)).run();
  if (inserted?.meta?.changes !== 1) return json({ error: '더 최신인 6-arm v2 보고가 이미 저장되어 있습니다.' }, 409);
  return json({ ok: true, experiment_id: report.experiment_id,
    shared_feed_sequence: report.shared_feed.sequence,
    snapshot_fingerprint: await sha256(JSON.stringify(report)) });
}

async function getBehaviorPaper(request, env) {
  const owner = await behaviorOwner(request, env);
  if (owner.response) return owner.response;
  const row = await env.DB.prepare(`
    SELECT captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_PAPER_SNAPSHOT_SOURCE).first();
  const experimentRow = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_ABC_SNAPSHOT_SOURCE).first();
  const multiExperimentRow = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_SNAPSHOT_SOURCE).first();
  const controlRow = await env.DB.prepare(`
    SELECT payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_CONTROL_SOURCE).first();
  const control = normalizeBehaviorMultiStopControl(controlRow);
  if (!control) return json({ error: '6-arm 제어 데이터를 읽지 못했습니다.' }, 500,
    { 'cache-control': 'private, no-store' });
  let v2Experiment = null;
  if (multiExperimentRow?.source === BEHAVIOR_MULTI_SNAPSHOT_SOURCE) {
    try { v2Experiment = normalizeBehaviorMultiPaperExperimentReport(JSON.parse(multiExperimentRow.payload)); }
    catch { v2Experiment = null; }
    if (!v2Experiment) return json({ error: '6-arm v2 보고 데이터를 읽지 못했습니다.' }, 500,
      { 'cache-control': 'private, no-store' });
  }
  const v2Active = v2Experiment && ['starting', 'active'].includes(v2Experiment.status) ? v2Experiment : null;
  let v1Experiment = null;
  if (!v2Active && experimentRow?.source === BEHAVIOR_ABC_SNAPSHOT_SOURCE) {
    try { v1Experiment = normalizeBehaviorPaperExperimentReport(JSON.parse(experimentRow.payload)); } catch { v1Experiment = null; }
    if (!v1Experiment) return json({ error: 'A/B/C 보고 데이터를 읽지 못했습니다.' }, 500,
      { 'cache-control': 'private, no-store' });
  }
  const experiment = v2Active || v1Experiment;
  const experimentReceivedAt = v2Active ? multiExperimentRow.captured_at : experimentRow?.captured_at ?? null;
  if (!row) return json({ session_id: BEHAVIOR_PAPER_SESSION_ID, deadline_at: BEHAVIOR_PAPER_DEADLINE,
    report: null, experiment, experiment_received_at: experimentReceivedAt, control }, 200,
  { 'cache-control': 'private, no-store' });
  let report;
  try { report = normalizeBehaviorPaperReport(JSON.parse(row.payload)); } catch { report = null; }
  if (!report) return json({ error: '보고 데이터를 읽지 못했습니다.' }, 500);
  return json({ report, received_at: row.captured_at, experiment, experiment_received_at: experimentReceivedAt,
    control }, 200,
    { 'cache-control': 'private, no-store' });
}

function normalizeLiveDecision(value) {
  if (!exactPaperKeys(value, ['at', 'symbol', 'direction', 'score', 'estimated_win_probability',
    'confidence_gate', 'spread_bps', 'net_reward_risk', 'reasons'])) return null;
  const at = normalizePaperTimestamp(value.at);
  if (!at || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(value.symbol)
    || !['long', 'short', 'stand-aside'].includes(value.direction)
    || ![value.score, value.spread_bps, value.net_reward_risk].every(Number.isFinite)
    || (value.estimated_win_probability !== null && (!Number.isFinite(value.estimated_win_probability)
      || value.estimated_win_probability < 0 || value.estimated_win_probability > 1))
    || (value.confidence_gate !== null && value.confidence_gate !== .7)
    || !Array.isArray(value.reasons) || value.reasons.length < 1 || value.reasons.length > 16
    || value.reasons.some((reason) => !boundedPaperText(reason, 80, true))) return null;
  return { ...value, at, reasons: [...value.reasons] };
}

function normalizeLiveOrder(value, modelId, symbols) {
  if (value === null) return null;
  const keys = ['order_id', 'client_oid', 'symbol', 'direction', 'quantity', 'requested_at', 'average_price',
    'status', 'stop_price', 'target_price', 'leverage', 'estimated_margin_usdt'];
  if (!exactPaperKeys(value, keys) || !boundedPaperText(value.order_id, 80, true)
    || !/^[.A-Z:/a-z0-9_-]{1,32}$/u.test(value.client_oid) || !symbols.includes(value.symbol)
    || !['long', 'short'].includes(value.direction) || !normalizePaperTimestamp(value.requested_at)
    || ![value.quantity, value.stop_price, value.target_price, value.leverage, value.estimated_margin_usdt]
      .every((number) => Number.isFinite(number) && number > 0)
    || value.estimated_margin_usdt > 3.00000001 || value.leverage > (modelId === 'beast' ? 25 : 6)
    || (value.average_price !== null && (!Number.isFinite(value.average_price) || value.average_price <= 0))
    || !boundedPaperText(value.status, 32, true)) return undefined;
  return { ...value, requested_at: normalizePaperTimestamp(value.requested_at) };
}

function normalizeLiveModel(value, expected) {
  const keys = ['id', 'name', 'style', 'symbols', 'allocation_usdt', 'leverage_cap', 'status', 'status_message',
    'last_decision', 'open_order', 'trade_count', 'win_count', 'loss_count', 'realized_pnl',
    'recent_decisions', 'recent_logs'];
  if (!exactPaperKeys(value, keys) || value.id !== expected.id || value.name !== expected.name
    || value.style !== expected.style || JSON.stringify(value.symbols) !== JSON.stringify(expected.symbols)
    || value.allocation_usdt !== 3 || value.leverage_cap !== expected.leverage
    || !['blocked', 'watching', 'open', 'degraded', 'error'].includes(value.status)
    || !boundedPaperText(value.status_message, 240, true) || !Number.isSafeInteger(value.trade_count)
    || !Number.isSafeInteger(value.win_count) || !Number.isSafeInteger(value.loss_count)
    || value.trade_count < 0 || value.trade_count > 100_000 || value.win_count < 0 || value.loss_count < 0
    || value.win_count + value.loss_count > value.trade_count || !Number.isFinite(value.realized_pnl)
    || !Array.isArray(value.recent_decisions) || value.recent_decisions.length > 30
    || !Array.isArray(value.recent_logs) || value.recent_logs.length > 40) return null;
  const lastDecision = value.last_decision === null ? null : normalizeLiveDecision(value.last_decision);
  const decisions = value.recent_decisions.map(normalizeLiveDecision);
  const openOrder = normalizeLiveOrder(value.open_order, expected.id, expected.symbols);
  const logs = value.recent_logs.map((log) => {
    if (!exactPaperKeys(log, ['sequence', 'at', 'level', 'message']) || !Number.isSafeInteger(log.sequence)
      || log.sequence < 1 || !normalizePaperTimestamp(log.at) || !['info', 'warn', 'error'].includes(log.level)
      || !boundedPaperText(log.message, 240, true)) return null;
    return { ...log, at: normalizePaperTimestamp(log.at) };
  });
  if ((value.last_decision !== null && !lastDecision) || decisions.some((item) => !item)
    || openOrder === undefined || logs.some((item) => !item)) return null;
  if (decisions.some((item, index) => index && Date.parse(item.at) > Date.parse(decisions[index - 1].at))
    || logs.some((item, index) => index && item.sequence > logs[index - 1].sequence)) return null;
  return { ...value, last_decision: lastDecision, open_order: openOrder, recent_decisions: decisions, recent_logs: logs };
}

export function normalizeBehaviorLiveReport(input) {
  const keys = ['schema', 'experiment_id', 'live_trading', 'generated_at', 'sequence', 'status', 'status_message',
    'exchange', 'allocation', 'models', 'warnings', 'fingerprint'];
  if (!exactPaperKeys(input, keys) || input.schema !== 'dual-live-v1'
    || input.experiment_id !== BEHAVIOR_LIVE_EXPERIMENT_ID || input.live_trading !== true
    || !normalizePaperTimestamp(input.generated_at) || !Number.isSafeInteger(input.sequence)
    || input.sequence < 0 || input.sequence > 1_000_000_000
    || !['blocked', 'armed', 'active', 'degraded', 'error'].includes(input.status)
    || !boundedPaperText(input.status_message, 240, true)
    || !exactPaperKeys(input.exchange, ['name', 'product', 'api', 'hold_mode'])
    || input.exchange.name !== 'Bitget' || input.exchange.product !== 'USDT-FUTURES'
    || input.exchange.api !== 'classic-v2' || ![null, 'one_way_mode', 'hedge_mode'].includes(input.exchange.hold_mode)
    || JSON.stringify(input.allocation) !== JSON.stringify({ per_model_usdt: 3, total_usdt: 6,
      mode: 'isolated-margin-hard-cap' })
    || !Array.isArray(input.models) || input.models.length !== 2 || !Array.isArray(input.warnings)
    || input.warnings.length < 1 || input.warnings.length > 6
    || input.warnings.some((warning) => !boundedPaperText(warning, 240, true))
    || !/^[a-f0-9]{64}$/u.test(input.fingerprint)) return null;
  const expected = [
    { id: 'beast', name: '야수의 심장', style: '수수료 반영 공격형 추세·돌파, 고레버리지',
      symbols: ['BTCUSDT', 'SOLUSDT'], leverage: 25 },
    { id: 'ddokdogi', name: '똑도기', style: '다중요인 합의와 보수적 확률 보정, 70% 문턱',
      symbols: ['ETHUSDT', 'XRPUSDT'], leverage: 6 },
  ];
  const models = input.models.map((model, index) => normalizeLiveModel(model, expected[index]));
  if (models.some((model) => !model)) return null;
  return { ...input, generated_at: normalizePaperTimestamp(input.generated_at), models };
}

function stableLiveJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableLiveJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableLiveJson(value[key])}`).join(',')}}`;
}

async function reportBehaviorLive(request, env) {
  if (!(await ingestTokenMatches(request, env.BEHAVIOR_PAPER_REPORT_TOKEN))) return json({ error: '인증이 필요합니다.' }, 401);
  const body = await readBehaviorPaperJson(request);
  if (body.error) return body.error;
  if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_BEHAVIOR_LIVE_BYTES) {
    return json({ error: '실투 보고가 너무 큽니다.' }, 413);
  }
  const report = normalizeBehaviorLiveReport(body.value);
  if (!report) return json({ error: '잘못된 실투 보고입니다.' }, 400);
  const { fingerprint, ...unsigned } = report;
  if (await sha256(stableLiveJson(unsigned)) !== fingerprint) return json({ error: '실투 보고 지문이 일치하지 않습니다.' }, 400);
  const capturedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
    WHERE CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
      > CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
      OR excluded.payload = usage_snapshots.payload
  `).bind(BEHAVIOR_LIVE_SNAPSHOT_SOURCE, capturedAt, JSON.stringify(report)).run();
  if (inserted?.meta?.changes !== 1) return json({ error: '더 최신인 실투 보고가 이미 저장되어 있습니다.' }, 409);
  return json({ ok: true, experiment_id: report.experiment_id, sequence: report.sequence, fingerprint });
}

async function getBehaviorLive(request, env) {
  const owner = await behaviorOwner(request, env); if (owner.response) return owner.response;
  const row = await env.DB.prepare(`SELECT captured_at, payload FROM usage_snapshots WHERE source = ?1 LIMIT 1`)
    .bind(BEHAVIOR_LIVE_SNAPSHOT_SOURCE).first();
  if (!row) return json({ report: null, received_at: null }, 200, { 'cache-control': 'private, no-store' });
  let report = null; try { report = normalizeBehaviorLiveReport(JSON.parse(row.payload)); } catch { report = null; }
  if (!report) return json({ error: '실투 보고 데이터를 읽지 못했습니다.' }, 500,
    { 'cache-control': 'private, no-store' });
  return json({ report, received_at: row.captured_at }, 200, { 'cache-control': 'private, no-store' });
}

function gichulError(message, status) {
  return json({ error: message }, status, GICHUL_HEADERS);
}

async function gichulSession(request, env) {
  const session = await authenticate(request, env);
  return session || null;
}

async function storedGichulManifest(env) {
  const object = await env.GICHUL.get('manifest.json');
  if (!object) return null;
  return object;
}

async function gichulManifest(request, env) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  const object = await storedGichulManifest(env);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function gichulPdf(request, env, id) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  if (!/^[a-z0-9_-]{1,160}$/u.test(id)) return gichulError('Not found', 404);

  const manifestObject = await storedGichulManifest(env);
  if (!manifestObject) return gichulError('Not found', 404);
  const manifest = await manifestObject.json();
  if (!Array.isArray(manifest?.exams)) throw new Error('invalid_gichul_manifest');
  const exam = manifest.exams.find((candidate) => candidate?.id === id);
  const key = typeof exam?.r2_key === 'string' ? exam.r2_key : '';
  if (!key || key.startsWith('/') || key.split('/').includes('..')) {
    return gichulError('Not found', 404);
  }

  const object = await env.GICHUL.get(key);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/pdf',
    },
  });
}

async function learningContent(request, env, app) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  const key = LEARNING_CONTENT_KEYS[app];
  if (!key) return gichulError('Not found', 404);
  const object = await env.GICHUL.get(key);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function learningImage(request, env, name) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  if (!/^[a-z0-9-]{1,120}\.webp$/u.test(name)) return gichulError('Not found', 404);
  const object = await env.GICHUL.get(`learning/smstudy/kice/${name}`);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'image/webp',
    },
  });
}

async function logout(request, env) {
  const rawToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (rawToken) {
    const timestamp = now();
    const ipAddress = clientIp(request);
    await env.DB.prepare(`
      UPDATE sessions
      SET expires_at = ?, last_seen_at = ?, ip_hash = ?, ip_address = ?, user_agent = ?
      WHERE token_hash = ?
    `)
      .bind(
        timestamp,
        timestamp,
        await sha256(ipAddress),
        ipAddress,
        (request.headers.get('user-agent') || '').slice(0, 240),
        await sha256(rawToken),
      )
      .run();
  }
  return json({ ok: true });
}

async function progress(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  if (request.method === 'GET') {
    const row = await env.DB.prepare(`
      SELECT data, updated_at
      FROM progress
      WHERE user_id = ? AND app = ?
    `).bind(session.user_id, app).first();
    return json({
      data: row ? JSON.parse(row.data) : null,
      updatedAt: row?.updated_at || 0,
    });
  }

  if (request.method === 'PUT') {
    const input = await readJson(request);
    const rawData = JSON.stringify(input.data ?? {});
    // WordMaster additionally carries 2,000 schedules, recent daily summaries and a resume queue.
    const progressLimit = app === 'wordmaster' ? 1_200_000 : MAX_PROGRESS_BYTES;
    if (new TextEncoder().encode(rawData).byteLength > progressLimit) {
      return json({ error: '기록이 너무 큽니다.' }, 413);
    }

    await env.DB.prepare(`
      INSERT INTO progress(user_id, app, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, app)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind(session.user_id, app, rawData, now()).run();
    await logActivity(env, session.user_id, 'progress_sync', app);
    return json({ ok: true });
  }

  return null;
}

async function sharedAnswers(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const rows = await env.DB.prepare(`
    SELECT question_id, display_answer
    FROM shared_answers
    WHERE app = ?
    ORDER BY created_at
  `).bind(app).all();
  return json({ answers: rows.results });
}

async function acceptAnswer(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const input = await readJson(request);
  const app = String(input.app);
  const questionId = String(input.questionId || '');
  const answer = String(input.answer || '').trim();
  const questionLabel = String(input.questionLabel || '').trim().slice(0, 300);
  const baseAnswer = String(input.baseAnswer || '').trim().slice(0, 500);

  if (!VALID_APPS.has(app) || !questionId || !answer || answer.length > 200) {
    return json({ error: '잘못된 답안입니다.' }, 400);
  }

  const answerWrite = await env.DB.prepare(`
    INSERT INTO shared_answers(
      app, question_id, normalized_answer, display_answer,
      created_by, created_at, question_label, base_answer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app, question_id, normalized_answer)
    DO UPDATE SET
      question_label = CASE
        WHEN excluded.question_label != '' THEN excluded.question_label
        ELSE shared_answers.question_label
      END,
      base_answer = CASE
        WHEN excluded.base_answer != '' THEN excluded.base_answer
        ELSE shared_answers.base_answer
      END
    WHERE (excluded.question_label != ''
      AND excluded.question_label != COALESCE(shared_answers.question_label, ''))
      OR (excluded.base_answer != ''
        AND excluded.base_answer != COALESCE(shared_answers.base_answer, ''))
  `).bind(
    app,
    questionId,
    normalizeAnswer(answer),
    answer,
    session.user_id,
    now(),
    questionLabel,
    baseAnswer,
  ).run();

  if (answerWrite?.meta?.changes !== 0) {
    await logActivity(env, session.user_id, 'shared_answer', app, questionId);
  }
  return json({ ok: true });
}

async function listUsers(env) {
  const currentTime = now();
  const rows = await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      u.last_login_at,
      (
        SELECT MAX(activity_session.last_seen_at)
        FROM sessions activity_session
        WHERE activity_session.user_id = u.id
          AND activity_session.role = 'user'
      ) last_activity_at,
      u.disabled,
      COALESCE(SUM(CASE WHEN a.event = 'login' THEN 1 ELSE 0 END), 0) logins,
      COUNT(DISTINCT CASE WHEN a.app = 'wordmaster' THEN a.id END) word_events,
      COUNT(DISTINCT CASE WHEN a.app = 'smstudy' THEN a.id END) sm_events,
      COUNT(DISTINCT CASE WHEN a.app = 'plstudy' THEN a.id END) pl_events,
      (
        SELECT COUNT(DISTINCT
          COALESCE(active_session.user_agent, '') || '|' ||
          COALESCE(active_session.ip_address, active_session.ip_hash, '')
        )
        FROM sessions active_session
        WHERE active_session.user_id = u.id
          AND active_session.role = 'user'
          AND active_session.expires_at > ?
      ) active_devices,
      (
        SELECT recent_session.ip_address
        FROM sessions recent_session
        WHERE recent_session.user_id = u.id
          AND recent_session.role = 'user'
          AND recent_session.last_seen_at > ?
        ORDER BY recent_session.last_seen_at DESC
        LIMIT 1
      ) recent_ip
    FROM users u
    LEFT JOIN activity a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id DESC
  `).bind(currentTime, currentTime - SESSION_HISTORY_MS).all();
  return json({ users: rows.results });
}

async function listSessions(env) {
  const currentTime = now();
  await env.DB.prepare('DELETE FROM sessions WHERE last_seen_at <= ?')
    .bind(currentTime - SESSION_HISTORY_MS)
    .run();
  const rows = await env.DB.prepare(`
    SELECT
      s.user_id,
      u.username,
      s.created_at,
      s.expires_at,
      s.last_seen_at,
      s.ip_address,
      SUBSTR(s.ip_hash, 1, 12) ip_fingerprint,
      s.user_agent
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.role = 'user' AND s.last_seen_at > ?
    ORDER BY s.last_seen_at DESC
    LIMIT 500
  `).bind(currentTime - SESSION_HISTORY_MS).all();

  return json({
    sessions: rows.results.map((session) => ({
      ...session,
      active: session.expires_at > currentTime,
    })),
  });
}

async function createUser(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || password.length < 6) {
    return json({ error: '아이디 형식 또는 비밀번호 길이를 확인하세요.' }, 400);
  }

  const salt = createToken();
  try {
    const result = await env.DB.prepare(`
      INSERT INTO users(username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(username, await passwordHash(password, salt), salt, now()).run();
    return json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    console.error('create_user', error);
    if (String(error?.message || error).includes('UNIQUE')) {
      return json({ error: '이미 존재하는 아이디입니다.' }, 409);
    }
    return json({ error: '사용자 생성에 실패했습니다.' }, 500);
  }
}

async function deleteUser(env, userId) {
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return json({ ok: true });
}

async function adminStats(env) {
  const currentTime = now();
  const totals = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) users,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > ${currentTime}) active_sessions,
      (SELECT COUNT(*) FROM activity WHERE created_at > ${currentTime - DAY_MS}) events_24h,
      (SELECT COUNT(*) FROM shared_answers) shared_answers,
      (
        SELECT COUNT(DISTINCT ip_address)
        FROM sessions
        WHERE role = 'user'
          AND ip_address IS NOT NULL
          AND ip_address != 'unknown'
          AND last_seen_at > ${currentTime - (30 * DAY_MS)}
      ) known_ips_30d
  `).first();
  const daily = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
      COUNT(*) events,
      COUNT(DISTINCT user_id) users
    FROM activity
    WHERE created_at > ?
    GROUP BY day
    ORDER BY day
  `).bind(currentTime - (14 * DAY_MS)).all();
  return json({ totals, daily: daily.results });
}

async function adminAnswers(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.app,
      s.question_id,
      s.question_label,
      s.base_answer,
      s.display_answer,
      s.created_at,
      u.username
    FROM shared_answers s
    LEFT JOIN users u ON u.id = s.created_by
    ORDER BY s.created_at DESC
    LIMIT 500
  `).all();
  return json({ answers: rows.results });
}

async function adminRoute(request, env, path) {
  const session = await authenticate(request, env, 'admin');
  if (!session) return json({ error: '관리자 로그인이 필요합니다.' }, 401);

  if (request.method === 'GET' && path === '/api/admin/users') return listUsers(env);
  if (request.method === 'POST' && path === '/api/admin/users') return createUser(request, env);

  const resetMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (resetMatch && request.method === 'POST') return resetUserPassword(request, env, Number(resetMatch[1]), session);

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && request.method === 'DELETE') {
    return deleteUser(env, Number(userMatch[1]));
  }

  if (request.method === 'GET' && path === '/api/admin/stats') return adminStats(env);
  if (request.method === 'GET' && path === '/api/admin/sessions') return listSessions(env);
  if (request.method === 'GET' && path === '/api/admin/answers') return adminAnswers(env);
  return null;
}

export async function route(request, env) {
  const path = new URL(request.url).pathname;
  const { method } = request;

  if (method === 'POST' && path === '/api/login') return login(request, env);
  if (method === 'POST' && path === '/api/admin/login') return adminLogin(request, env);

  if (method === 'GET' && path === '/api/behavior-lab/paper') {
    return getBehaviorPaper(request, env);
  }
  if (method === 'GET' && path === '/api/behavior-lab/paper/control') {
    return getBehaviorMultiPaperControl(request, env);
  }
  if (method === 'POST' && path === '/api/behavior-lab/paper/stop') {
    return stopBehaviorMultiPaper(request, env);
  }
  if (method === 'POST' && path === '/api/behavior-lab/paper/report') {
    return reportBehaviorPaper(request, env);
  }
  if (method === 'GET' && path === '/api/behavior-lab/live') return getBehaviorLive(request, env);
  if (method === 'POST' && path === '/api/behavior-lab/live/report') return reportBehaviorLive(request, env);

  if (method === 'GET' && path === '/api/me') {
    const session = await authenticate(request, env);
    return session
      ? json({ user: { id: session.user_id, username: session.username } })
      : json({ error: '로그인이 필요합니다.' }, 401);
  }

  if (method === 'POST' && path === '/api/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/competitions/report') {
    return reportCompetitions(request, env);
  }
  const competitionApprovalMatch = path.match(
    /^\/api\/competitions\/approvals\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/decision$/u,
  );
  if (method === 'POST' && competitionApprovalMatch) {
    return decideCompetitionApproval(request, env, competitionApprovalMatch[1]);
  }
  if (method === 'GET' && path === '/api/competitions') return getCompetitions(request, env);
  if (method === 'GET' && path === '/api/gichul/manifest') return gichulManifest(request, env);

  const learningContentMatch = path.match(/^\/api\/learning\/(wordmaster|smstudy|plstudy)$/u);
  if (method === 'GET' && learningContentMatch) {
    return learningContent(request, env, learningContentMatch[1]);
  }

  const learningImageMatch = path.match(/^\/api\/learning\/smstudy\/image\/([^/]+)$/u);
  if (method === 'GET' && learningImageMatch) {
    return learningImage(request, env, learningImageMatch[1]);
  }

  const gichulPdfMatch = path.match(/^\/api\/gichul\/pdf\/(.+)$/u);
  if (method === 'GET' && gichulPdfMatch) {
    return gichulPdf(request, env, gichulPdfMatch[1]);
  }

  const progressMatch = path.match(/^\/api\/progress\/(wordmaster|smstudy|plstudy)$/);
  if (progressMatch) {
    const response = await progress(request, env, progressMatch[1]);
    if (response) return response;
  }

  const answersMatch = path.match(/^\/api\/answers\/(wordmaster|smstudy|plstudy)$/);
  if (answersMatch && method === 'GET') {
    return sharedAnswers(request, env, answersMatch[1]);
  }

  if (method === 'POST' && path === '/api/answers/accept') {
    return acceptAnswer(request, env);
  }

  if (path.startsWith('/api/admin/')) {
    const response = await adminRoute(request, env, path);
    if (response) return response;
  }

  return json({ error: 'Not found' }, 404);
}
