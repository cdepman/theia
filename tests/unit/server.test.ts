import { describe, expect, it } from 'vitest';
import { type Db } from '../../pipeline/db';
import { gate } from '../../server/gate';
import { type ApiContext, handleApi } from '../../server/routes';
import { constantTimeEqual, parseCookies, SESSION_COOKIE, signSession, verifySession } from '../../shared/auth';

const KEY = 'test-signing-key-0123456789';
const NOW = Date.parse('2026-11-21T12:00:00Z');

describe('session signing', () => {
  it('accepts a valid session and rejects tampered, expired or foreign ones', async () => {
    const good = await signSession(KEY, NOW + 60_000);
    expect(await verifySession(KEY, good, NOW)).toBe(true);
    expect(await verifySession(KEY, good, NOW + 120_000)).toBe(false);
    expect(await verifySession('another-key', good, NOW)).toBe(false);
    const [exp, sig] = good.split('.');
    expect(await verifySession(KEY, `${Number(exp) + 1_000_000}.${sig}`, NOW)).toBe(false);
    expect(await verifySession(KEY, 'garbage', NOW)).toBe(false);
    expect(await verifySession(undefined, good, NOW)).toBe(false);
    expect(await verifySession(KEY, undefined, NOW)).toBe(false);
  });

  it('compares secrets without short-circuiting on length', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(parseCookies('a=1; theia_session=x.y; b=2')[SESSION_COOKIE]).toBe('x.y');
  });
});

describe('access gate', () => {
  const env = { GATE_PASSWORD: 'correct horse battery staple', GATE_SIGNING_KEY: KEY, WORKER_SECRET: 'w-secret', STATUS_CHECK_SECRET: 's-secret' };
  const req = (path: string, init: RequestInit = {}) => new Request(`https://theia.example${path}`, init);

  it('fails closed when it is not configured', async () => {
    const d = await gate(req('/'), {});
    expect(d.action).toBe('respond');
    if (d.action === 'respond') expect(d.response.status).toBe(503);
  });

  it('shows the sign-in page for pages and returns 401 JSON for the API', async () => {
    const page = await gate(req('/'), env);
    expect(page.action === 'respond' && page.response.status).toBe(401);
    const api = await gate(req('/api/stories?country=US'), env);
    expect(api.action === 'respond' && api.response.headers.get('content-type')).toContain('application/json');
    const direct = await gate(req('/.netlify/functions/api'), env);
    expect(direct.action === 'respond' && direct.response.status).toBe(401);
  });

  it('exchanges the password for a signed, HttpOnly, Secure cookie', async () => {
    const form = (password: string) => req('/auth/login', { method: 'POST', body: new URLSearchParams({ password }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const bad = await gate(form('wrong'), env, NOW);
    expect(bad.action === 'respond' && bad.response.status).toBe(401);
    const ok = await gate(form(env.GATE_PASSWORD), env, NOW);
    expect(ok.action).toBe('respond');
    if (ok.action !== 'respond') return;
    expect(ok.response.status).toBe(303);
    const cookie = ok.response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const value = /theia_session=([^;]+)/.exec(cookie)![1]!;
    const next = await gate(req('/api/stories', { headers: { cookie: `${SESSION_COOKIE}=${value}` } }), env, NOW + 1000);
    expect(next.action).toBe('next');
  });

  it('lets machine callers through only on their own route with their own secret', async () => {
    const worker = (secret: string, path = '/.netlify/functions/worker-background') => gate(req(path, { method: 'POST', headers: { 'x-theia-worker-secret': secret } }), env);
    expect((await worker('w-secret')).action).toBe('next');
    expect((await worker('nope')).action).toBe('respond');
    expect((await worker('w-secret', '/api/stories')).action).toBe('respond');
    const status = (secret: string, path = '/api/data-status') => gate(req(path, { headers: { 'x-theia-status-secret': secret } }), env);
    expect((await status('s-secret')).action).toBe('next');
    expect((await status('s-secret', '/api/admin/status')).action).toBe('respond');
  });
});

describe('read API', () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: Db = {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      calls.push({ fn, args });
      if (fn === 'theia_get_view') return (args.p_country === 'JP' ? null : { country: args.p_country, stories: [] }) as T;
      if (fn === 'theia_get_story') return null as T;
      if (fn === 'theia_data_status') return { ok: true } as T;
      return {} as T;
    },
  };
  const open: ApiContext = { db, env: { THEIA_DEV_NO_AUTH: '1' } };
  const get = (path: string, ctx: ApiContext = open, headers: Record<string, string> = {}) => handleApi(new Request(`https://theia.example${path}`, { headers }), ctx);

  it('validates country, category and window against allowlists before touching the database', async () => {
    calls.length = 0;
    expect((await get('/api/stories?country=FR')).status).toBe(400);
    expect((await get('/api/stories?country=US&category=gossip')).status).toBe(400);
    expect((await get("/api/stories?country=US&window=1y';drop table x")).status).toBe(400);
    expect((await get('/api/stories/not-a-uuid?country=US')).status).toBe(400);
    expect(calls).toEqual([]);
    const ok = await get('/api/stories?country=GB&category=technology&window=7d');
    expect(ok.status).toBe(200);
    expect(calls[0]).toEqual({ fn: 'theia_get_view', args: { p_country: 'GB', p_category: 'technology', p_window: '7d' } });
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
  });

  it('returns an explicit empty view when nothing has been computed, and 404 for unknown items', async () => {
    const empty = await (await get('/api/stories?country=JP&window=30d')).json();
    expect(empty).toMatchObject({ notComputed: true, unit: 'thread', metric: 'publisher_days', stories: [] });
    expect((await get('/api/stories/00000000-0000-4000-8000-000000000000?country=US')).status).toBe(404);
    expect((await get('/api/nope')).status).toBe(404);
  });

  it('is read-only and requires a session outside local development', async () => {
    expect((await handleApi(new Request('https://theia.example/api/stories?country=US', { method: 'POST' }), open)).status).toBe(405);
    const locked = { db, env: { GATE_SIGNING_KEY: KEY, STATUS_CHECK_SECRET: 's-secret' } };
    expect((await get('/api/stories?country=US', locked)).status).toBe(401);
    const session = await signSession(KEY, Date.now() + 60_000);
    expect((await get('/api/stories?country=US', locked, { cookie: `${SESSION_COOKIE}=${session}` })).status).toBe(200);
    // The status secret opens the status route and nothing else.
    expect((await get('/api/data-status', locked, { 'x-theia-status-secret': 's-secret' })).status).toBe(200);
    expect((await get('/api/admin/status', locked, { 'x-theia-status-secret': 's-secret' })).status).toBe(401);
    // With no signing key configured the API refuses to serve at all.
    expect((await get('/api/stories?country=US', { db, env: {} })).status).toBe(503);
  });

  it('does not leak database errors', async () => {
    const failing: Db = { rpc: async () => { throw new Error('connection to 10.0.0.5 refused: password authentication failed'); } };
    const res = await handleApi(new Request('https://theia.example/api/meta'), { db: failing, env: { THEIA_DEV_NO_AUTH: '1' } });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/password|10\.0\.0\.5/);
  });
});
