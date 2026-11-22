import { type Db } from '../db';
import { originsWithoutCredentials } from '../providers/signals/providers';

export interface DispatchStatus {
  paused: boolean;
  dueSources: number;
  staleCountries: string[];
  pendingLanguages: string[];
  /** Attention-signal sources that are due and have credentials. */
  dueSignals: number;
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
  opts: { now?: () => Date; env?: Record<string, string | undefined> } = {},
): Promise<DispatchResult> {
  const nowArg = opts.now ? { p_now: opts.now().toISOString() } : {};
  const tick = await db.rpc<Omit<DispatchStatus, 'dueSignals'>>('theia_dispatch_tick', nowArg);
  if (tick.paused) return { ...tick, dueSignals: 0, invoked: false };
  const dueSignals = await db.rpc<number>('theia_signals_due', { p_exclude_origins: originsWithoutCredentials(opts.env ?? process.env), ...nowArg });
  const status: DispatchStatus = { ...tick, dueSignals };
  const hasWork = status.dueSignals > 0 || status.dueSources > 0 || status.staleCountries.length > 0 || status.pendingLanguages.length > 0;
  if (hasWork) await invokeWorker(status);
  return { ...status, invoked: hasWork };
}
