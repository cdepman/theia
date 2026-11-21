import type { Config } from '@netlify/functions';
import { dbFromEnv } from '../../pipeline/db';
import { dispatchTick } from '../../pipeline/jobs/dispatcher';

// Scheduled dispatcher. It must finish well inside the scheduled-function time limit,
// so it only records a heartbeat, asks Postgres whether there is work, and wakes the worker.
export default async (): Promise<void> => {
  const db = dbFromEnv();
  const siteUrl = process.env.URL;
  const secret = process.env.WORKER_SECRET;
  const result = await dispatchTick(db, async (status) => {
    if (!siteUrl || !secret) throw new Error('URL or WORKER_SECRET is not set; cannot wake the worker.');
    const res = await fetch(`${siteUrl}/.netlify/functions/worker-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-theia-worker-secret': secret },
      body: JSON.stringify({ staleCountries: status.staleCountries }),
      signal: AbortSignal.timeout(10_000),
    });
    // A background function answers 202 at once. Anything else means the wake-up did not land;
    // the next tick will try again because the work is still due.
    if (res.status !== 202 && !res.ok) throw new Error(`worker wake-up returned HTTP ${res.status}`);
  });
  console.log('[theia dispatcher]', JSON.stringify(result));
};

export const config: Config = { schedule: '*/15 * * * *' };
