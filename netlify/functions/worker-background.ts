import { dbFromEnv } from '../../pipeline/db';
import { runWorker } from '../../pipeline/jobs/worker';
import { constantTimeEqual } from '../../shared/auth';
import { isCountry } from '../../shared/constants';

// Background worker (the `-background` suffix gives it the long execution limit).
// Its URL is reachable over HTTP, so every invocation must carry the shared secret.
export default async (req: Request): Promise<Response> => {
  const expected = process.env.WORKER_SECRET;
  const provided = req.headers.get('x-theia-worker-secret');
  if (!expected || !provided || !(await constantTimeEqual(provided, expected))) {
    return new Response('forbidden', { status: 403 });
  }
  let staleCountries: string[] = [];
  try {
    const body = (await req.json()) as { staleCountries?: unknown };
    if (Array.isArray(body.staleCountries)) staleCountries = body.staleCountries.filter(isCountry);
  } catch {
    /* an empty body is fine */
  }
  const summary = await runWorker(dbFromEnv(), {
    staleCountries,
    log: (message, detail) => console.log(`[theia worker] ${message}`, detail ? JSON.stringify(detail) : ''),
  });
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'content-type': 'application/json' } });
};
