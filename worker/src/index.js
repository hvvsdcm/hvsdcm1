import { corsHeaders, json } from './lib.js';
import { route } from './router.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    const path = new URL(request.url).pathname;
    const isGichulRequest = path.startsWith('/api/gichul/');
    const isBehaviorLabRequest = path.startsWith('/api/behavior-lab/');
    const isPasswordResetRequest = /^\/api\/admin\/users\/[^/]+\/password$/.test(path);
    const privateNoStore = isBehaviorLabRequest || isPasswordResetRequest
      ? 'private, no-store' : isGichulRequest ? 'no-store' : null;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      if (privateNoStore) headers.set('cache-control', privateNoStore);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // 내부 예외는 Worker 로그에만 남기고 SQL·환경 정보는 클라이언트에 노출하지 않는다.
      if (isPasswordResetRequest) console.error('password_reset_request_failed');
      else console.error('unhandled_request_error', error);
      return json(
        { error: '서버 오류' },
        500,
        privateNoStore ? { ...cors, 'cache-control': privateNoStore } : cors,
      );
    }
  },
};
