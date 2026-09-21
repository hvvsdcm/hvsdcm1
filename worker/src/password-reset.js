import { createToken, json, now, passwordHash } from './lib.js';

const MAX_BODY_BYTES = 4096;
const response = (data, status = 200) => json(data, status, { 'cache-control': 'no-store' });

async function boundedInput(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
}

// Password replacement and session revocation are one D1 transaction. Progress and
// audit history are deliberately not deleted. Password values never enter responses or logs.
export async function resetUserPassword(request, env, userId, adminSession) {
  if (adminSession?.role !== 'admin') return response({ error: '관리자 로그인이 필요합니다.' }, 401);
  if (!Number.isSafeInteger(userId) || userId < 1) return response({ error: '올바른 사용자 번호가 아닙니다.' }, 400);
  const input = await boundedInput(request);
  if (input === null) return response({ error: '요청이 너무 큽니다.' }, 413);
  const password = input?.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !password.trim()) {
    return response({ error: '새 비밀번호는 8자 이상 128자 이하로 입력하세요.' }, 400);
  }
  if (password !== input.confirmPassword) return response({ error: '비밀번호 확인이 일치하지 않습니다.' }, 400);

  try {
    const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?').bind(userId).first();
    if (!user) return response({ error: '사용자를 찾을 수 없습니다.' }, 404);
    const salt = createToken();
    const hash = await passwordHash(password, salt);
    const at = now();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE users SET password_hash = ?, password_salt = ?
        WHERE id = ? AND password_hash = ?
      `).bind(hash, salt, userId, user.password_hash),
      env.DB.prepare(`
        UPDATE sessions SET expires_at = ?
        WHERE user_id = ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)
      `).bind(at, userId, at, userId, hash),
      env.DB.prepare(`
        INSERT INTO activity (user_id, event, app, created_at, detail)
        SELECT id, 'password_reset_by_admin', NULL, ?, NULL
        FROM users WHERE id = ? AND password_hash = ?
      `).bind(at, userId, hash),
    ]);
    if (results[0]?.meta?.changes !== 1) return response({ error: '계정 정보가 변경되었습니다. 새로고침 후 다시 시도하세요.' }, 409);
    return response({ ok: true });
  } catch {
    return response({ error: '비밀번호를 초기화하지 못했습니다. 다시 시도하세요.' }, 500);
  }
}
