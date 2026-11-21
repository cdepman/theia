import { type Db } from '../db';

export interface DispatchStatus {
  paused: boolean;
  dueSources: number;
  staleCountries: string[];
  pendingLanguages: string[];
}

export interface DispatchResult extends DispatchStatus {
  invoked: boolean;
}

/**
 * The dispatcher tick. It records a heartbeat, asks Postgres whether there is work,
 * and wakes the worker if there is. A tick is only a wake-up signal: due work is
 * derived from the schedule rows on every tick, so a failed invocation or a missed
 * tick is recovered by the next one.
 */
export async function dispatchTick(
  db: Db,
  invokeWorker: (status: DispatchStatus) => Promise<void>,
  opts: { now?: () => Date } = {},
): Promise<DispatchResult> {
  const status = await db.rpc<DispatchStatus>('theia_dispatch_tick', opts.now ? { p_now: opts.now().toISOString() } : {});
  if (status.paused) return { ...status, invoked: false };
  const hasWork = status.dueSources > 0 || status.staleCountries.length > 0 || status.pendingLanguages.length > 0;
  if (hasWork) await invokeWorker(status);
  return { ...status, invoked: hasWork };
}
