import type { Config } from '@netlify/functions';
import { dbFromEnv } from '../../pipeline/db';
import { handleApi } from '../../server/routes';

// The read API. The Edge Function gate runs first; this handler checks the session
// again so that reaching the function by its direct URL changes nothing.
export default async (req: Request): Promise<Response> => {
  try {
    return await handleApi(req, {
      db: dbFromEnv(),
      env: { GATE_SIGNING_KEY: process.env.GATE_SIGNING_KEY, STATUS_CHECK_SECRET: process.env.STATUS_CHECK_SECRET },
    });
  } catch (e) {
    console.error('[theia api] configuration error:', (e as Error).message);
    return new Response(JSON.stringify({ error: { code: 'not_configured', message: 'The API is not configured.' } }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};

export const config: Config = { path: '/api/*' };
