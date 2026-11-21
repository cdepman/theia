// Session signing for the access gate. Uses only Web APIs, so the same module runs in
// the Netlify Edge Function (Deno), in Netlify Functions (Node), and in the local dev server.

export const SESSION_COOKIE = 'theia_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Compares two strings without leaking where they differ, by comparing fixed-length digests. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = da.length ^ db.length;
  for (let i = 0; i < da.length; i++) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0;
}

export async function signSession(signingKey: string, expiresAtMs: number): Promise<string> {
  const payload = String(Math.floor(expiresAtMs));
  return `${payload}.${await hmac(signingKey, `theia-session:${payload}`)}`;
}

export async function verifySession(signingKey: string | undefined, value: string | undefined, nowMs: number): Promise<boolean> {
  if (!signingKey || !value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^\d{10,16}$/.test(payload)) return false;
  if (Number(payload) <= nowMs) return false;
  return constantTimeEqual(signature, await hmac(signingKey, `theia-session:${payload}`));
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sessionCookie(value: string, opts: { secure: boolean; maxAgeSeconds?: number }): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS}`,
  ];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

export async function hasValidSession(req: Request, signingKey: string | undefined, nowMs = Date.now()): Promise<boolean> {
  return verifySession(signingKey, parseCookies(req.headers.get('cookie'))[SESSION_COOKIE], nowMs);
}
