const encoder = new TextEncoder();

export const DAY_MS = 86_400_000;
export const SESSION_DURATION_MS = 30 * DAY_MS;

export const now = () => Date.now();

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(digest);
}

export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: encoder.encode(salt),
    iterations: 100_000,
  }, key, 256);
  return bytesToBase64(derived);
}

export function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,/#!$%^&*;:{}=\-_~()\[\]"'“”‘’?<>·]+/g, '')
    .trim();
}

export function clientIp(request) {
  const value = (request.headers.get('cf-connecting-ip') || '').trim();
  return (value || 'unknown').slice(0, 64);
}

export async function authenticate(request, env, requiredRole = 'user') {
  const rawToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!rawToken) return null;

  const tokenHash = await sha256(rawToken);
  const session = await env.DB.prepare(`
    SELECT s.*, u.username, u.disabled
    FROM sessions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE token_hash = ? AND expires_at > ?
  `).bind(tokenHash, now()).first();

  if (!session || session.disabled || (requiredRole === 'admin' && session.role !== 'admin')) {
    return null;
  }

  const ipAddress = clientIp(request);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 240);
  await env.DB.prepare(`
    UPDATE sessions
    SET last_seen_at = ?, ip_hash = ?, ip_address = ?, user_agent = ?
    WHERE token_hash = ?
  `)
    .bind(now(), await sha256(ipAddress), ipAddress, userAgent, session.token_hash)
    .run();
  return session;
}

// Owner-only operational routes share this single fail-closed username rule. An empty or missing
// OWNER_USERNAME never grants access, and an authenticated non-owner is hidden behind a 404.
export function ownerUsernames(env) {
  return String(env.OWNER_USERNAME || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

export function isOwnerSession(session, env) {
  const username = String(session?.username || '').trim().toLowerCase();
  return username.length > 0 && ownerUsernames(env).includes(username);
}

export async function logActivity(env, userId, event, app = null, detail = null) {
  await env.DB.prepare(`
    INSERT INTO activity(user_id, event, app, created_at, detail)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId || null, event, app, now(), detail).run();
}

export async function issueSession(env, userId, role, request, expectedPasswordHash = null) {
  const rawToken = createToken();
  const issuedAt = now();
  const ipAddress = clientIp(request);
  const ipHash = await sha256(ipAddress);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 240);

  // Bind session issuance to the exact password checked before an asynchronous reset.
  const guard = expectedPasswordHash === null ? '' : ' WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND disabled = 0)';
  const values = [
    await sha256(rawToken), userId || null, role, issuedAt, issuedAt + SESSION_DURATION_MS,
    issuedAt, ipHash, ipAddress, userAgent,
  ];
  if (expectedPasswordHash !== null) values.push(userId, expectedPasswordHash);
  const inserted = await env.DB.prepare(`
    INSERT INTO sessions(
      token_hash, user_id, role, created_at, expires_at, last_seen_at,
      ip_hash, ip_address, user_agent
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?${guard}
  `).bind(...values).run();

  if (expectedPasswordHash !== null && inserted.meta?.changes === 0) return null;
  return rawToken;
}
