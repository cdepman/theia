import {
  constantTimeEqual,
  hasValidSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
  signSession,
} from '../shared/auth.ts';

export interface GateEnv {
  GATE_PASSWORD?: string;
  GATE_SIGNING_KEY?: string;
  STATUS_CHECK_SECRET?: string;
  WORKER_SECRET?: string;
}

export type GateDecision = { action: 'next' } | { action: 'respond'; response: Response };

const WORKER_PATH = '/.netlify/functions/worker-background';

function page(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Project Theia</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ec; color: #1c1a17;
         font: 16px/1.5 ui-serif, Georgia, 'Times New Roman', serif; }
  main { width: min(22rem, 86vw); }
  h1 { font-size: 1.6rem; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 0.25rem; }
  p { margin: 0 0 1.25rem; color: #6b655c; font-size: 0.95rem; }
  label { display: block; font: 600 0.72rem/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.4rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.7rem 0.8rem; font: inherit; border: 1px solid #b9b2a5; border-radius: 4px; background: #fffdf8; color: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid #1c1a17; outline-offset: 2px; }
  button { margin-top: 0.9rem; width: 100%; padding: 0.7rem; font: 600 0.9rem ui-sans-serif, system-ui, sans-serif; border: 0; border-radius: 4px; background: #1c1a17; color: #f6f3ec; cursor: pointer; }
  .err { color: #a3261b; font: 0.85rem ui-sans-serif, system-ui, sans-serif; margin-top: 0.75rem; }
  @media (prefers-color-scheme: dark) { body { background: #151412; color: #ece7dc; } p { color: #a39c8f; } input { background: #1e1c19; border-color: #4a453d; } button { background: #ece7dc; color: #151412; } }
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...headers } },
  );
}

function loginPage(status: number, failed: boolean): Response {
  return page(
    `<h1>Project Theia</h1><p>Private. Enter the access password to continue.</p>
     <form method="post" action="/auth/login"><label for="password">Password</label>
     <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
     <button type="submit">Continue</button>${failed ? '<div class="err" role="alert">That password was not accepted.</div>' : ''}</form>`,
    status,
  );
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * The access gate, run on every request before anything is served.
 *
 * - A valid signed session cookie passes.
 * - `/auth/login` exchanges the shared password for a session cookie.
 * - The worker endpoint and `/api/data-status` may instead present their own secret,
 *   which those handlers verify again themselves.
 * - Everything else gets the sign-in page (or a 401 for API calls).
 *
 * If the gate is not configured it fails closed.
 */
export async function gate(req: Request, env: GateEnv, nowMs = Date.now()): Promise<GateDecision> {
  const url = new URL(req.url);
  const path = url.pathname;
  const secure = url.protocol === 'https:';

  if (!env.GATE_PASSWORD || !env.GATE_SIGNING_KEY) {
    return {
      action: 'respond',
      response: page('<h1>Project Theia</h1><p>Access control is not configured. Set GATE_PASSWORD and GATE_SIGNING_KEY, then redeploy.</p>', 503),
    };
  }

  if (path === '/auth/logout') {
    return {
      action: 'respond',
      response: new Response(null, { status: 303, headers: { location: '/', 'set-cookie': sessionCookie('', { secure, maxAgeSeconds: 0 }), 'cache-control': 'no-store' } }),
    };
  }

  if (path === '/auth/login') {
    if (req.method !== 'POST') return { action: 'respond', response: loginPage(200, false) };
    let password = '';
    try {
      password = String((await req.formData()).get('password') ?? '');
    } catch {
      password = '';
    }
    if (!password || !(await constantTimeEqual(password, env.GATE_PASSWORD))) {
      // A fixed delay blunts guessing without keeping any state.
      await new Promise((r) => setTimeout(r, 750));
      return { action: 'respond', response: loginPage(401, true) };
    }
    const value = await signSession(env.GATE_SIGNING_KEY, nowMs + SESSION_MAX_AGE_SECONDS * 1000);
    return {
      action: 'respond',
      response: new Response(null, { status: 303, headers: { location: '/', 'set-cookie': sessionCookie(value, { secure }), 'cache-control': 'no-store' } }),
    };
  }

  if (await hasValidSession(req, env.GATE_SIGNING_KEY, nowMs)) return { action: 'next' };

  // Machine callers with their own secrets. Each handler verifies its secret again.
  const workerSecret = req.headers.get('x-theia-worker-secret');
  if (path === WORKER_PATH && env.WORKER_SECRET && workerSecret && (await constantTimeEqual(workerSecret, env.WORKER_SECRET))) {
    return { action: 'next' };
  }
  const statusSecret = req.headers.get('x-theia-status-secret');
  if (path === '/api/data-status' && env.STATUS_CHECK_SECRET && statusSecret && (await constantTimeEqual(statusSecret, env.STATUS_CHECK_SECRET))) {
    return { action: 'next' };
  }

  if (path.startsWith('/api/') || path.startsWith('/.netlify/')) {
    return { action: 'respond', response: jsonError(401, 'unauthorized', 'Sign in to continue.') };
  }
  return { action: 'respond', response: loginPage(401, false) };
}

export { SESSION_COOKIE };
