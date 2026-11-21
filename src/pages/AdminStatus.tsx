import { COUNTRY_NAMES, type CountryCode } from '../../shared/constants';
import { PageHeader } from '../App';
import { useAdminStatus } from '../lib/api/client';
import { bytes, duration, formatDateTime, relativeTime } from '../lib/format';

// Supabase Free plan database limit. Shown for context; change if the plan changes.
const PLAN_LIMIT_BYTES = 500 * 1024 * 1024;

const PROBLEM_TEXT: Record<string, string> = {
  dispatcher_heartbeat_stale: 'The scheduler has not checked in recently.',
  views_stale: 'Views are past their refresh target',
  sources_need_attention: 'Sources have failed repeatedly',
};

function Cell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`border-t border-shore/70 px-2 py-1.5 align-top ${className}`}>{children}</td>;
}

export function AdminStatusPage() {
  const { data, isPending, isError, error, dataUpdatedAt } = useAdminStatus();
  return (
    <div className="min-h-full">
      <PageHeader />
      <main className="mx-auto max-w-[72rem] px-5 pb-16 pt-8 md:px-8">
        <h2 className="m-0 text-[2rem] font-medium leading-tight tracking-[-0.02em]">Pipeline status</h2>
        {isPending && <p className="text-ink-soft">Loading status.</p>}
        {isError && (
          <p className="rounded-sm bg-alert-wash px-3 py-2 text-alert" role="alert">
            Status could not be loaded: {error.message}
          </p>
        )}
        {data && (
          <>
            <p className="tabular mt-1 text-[0.9rem] text-ink-soft">Read {relativeTime(new Date(dataUpdatedAt).toISOString())}. Refreshes every minute.</p>

            <div
              role="status"
              className={`mt-4 rounded-sm px-4 py-3 ${data.status.ok ? 'bg-cobalt-wash text-ink' : 'bg-alert-wash text-alert'}`}
            >
              <p className="m-0 text-[1.1rem] font-semibold">
                {data.status.paused ? 'Dispatch is paused.' : data.status.ok ? 'Everything is within its targets.' : 'Something needs attention.'}
              </p>
              {data.status.problems.length > 0 && (
                <ul className="m-0 mt-1 list-disc pl-5 text-[0.95rem]">
                  {data.status.problems.map((p, i) => (
                    <li key={i}>
                      {PROBLEM_TEXT[p.code] ?? p.code}
                      {typeof p.country === 'string' ? ` for ${COUNTRY_NAMES[p.country as CountryCode] ?? p.country}.` : ''}
                      {Array.isArray(p.sources) ? `: ${(p.sources as string[]).join(', ')}.` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {data.status.activeSourceCount === 0 && <p className="m-0 mt-1 text-[0.95rem]">No sources are enabled, so there is nothing to collect.</p>}
            </div>

            <section className="mt-8 grid gap-x-10 gap-y-6 md:grid-cols-3">
              <div>
                <h3 className="m-0 text-[1.05rem] font-semibold">Heartbeats</h3>
                <dl className="tabular m-0 mt-2 text-[0.95rem]">
                  {['dispatcher', 'worker', 'refresh'].map((c) => {
                    const h = data.heartbeats.find((x) => x.component === c);
                    return (
                      <div key={c} className="flex justify-between border-t border-shore/70 py-1.5">
                        <dt className="capitalize">{c}</dt>
                        <dd className="m-0 text-ink-soft">{h ? `${duration(h.ageSeconds)} ago` : 'never'}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
              <div>
                <h3 className="m-0 text-[1.05rem] font-semibold">Totals</h3>
                <dl className="tabular m-0 mt-2 text-[0.95rem]">
                  {(
                    [
                      ['Articles', data.totals.articles],
                      ['Stories', data.totals.stories],
                      ['Subjects', data.totals.threads],
                      ['Subjects with more than one story', data.totals.multiStoryThreads],
                      ['Monitored publishers', `${data.totals.activePublishers} of ${data.totals.candidatePublishers} recorded`],
                    ] as [string, number | string | undefined][]
                  ).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4 border-t border-shore/70 py-1.5">
                      <dt>{k}</dt>
                      <dd className="m-0 text-ink-soft">{typeof v === 'number' ? v.toLocaleString('en') : (v ?? 0)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <h3 className="m-0 text-[1.05rem] font-semibold">Storage</h3>
                <dl className="tabular m-0 mt-2 text-[0.95rem]">
                  <div className="flex justify-between border-t border-shore/70 py-1.5">
                    <dt>Database</dt>
                    <dd className="m-0 text-ink-soft">
                      {bytes(data.totals.databaseBytes ?? 0)} of {bytes(PLAN_LIMIT_BYTES)} ({(((data.totals.databaseBytes ?? 0) / PLAN_LIMIT_BYTES) * 100).toFixed(1)}%)
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-shore/70 py-1.5">
                    <dt>Theia tables and indexes</dt>
                    <dd className="m-0 text-ink-soft">{bytes(data.totals.theiaBytes ?? 0)}</dd>
                  </div>
                </dl>
                {(data.totals.databaseBytes ?? 0) > PLAN_LIMIT_BYTES * 0.7 && (
                  <p className="mt-2 text-[0.9rem] text-alert">Past 70% of the plan limit. Plan for more storage.</p>
                )}
              </div>
            </section>

            <section className="mt-8">
              <h3 className="m-0 text-[1.05rem] font-semibold">Views by country</h3>
              <table className="tabular mt-2 w-full border-collapse text-left text-[0.95rem]">
                <thead>
                  <tr className="text-[0.85rem] text-ink-soft">
                    <th className="px-2 py-1 font-normal">Country</th>
                    <th className="px-2 py-1 font-normal">Monitored publishers</th>
                    <th className="px-2 py-1 font-normal">Sources last checked</th>
                    <th className="px-2 py-1 font-normal">Views computed</th>
                    <th className="px-2 py-1 font-normal">State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.status.countries.map((c) => (
                    <tr key={c.code}>
                      <Cell>{COUNTRY_NAMES[c.code]}</Cell>
                      <Cell>{c.monitoredPublisherCount}</Cell>
                      <Cell>{c.dataAsOf ? relativeTime(c.dataAsOf) : 'never'}</Cell>
                      <Cell>{c.lastComputedAt ? `${duration(c.viewAgeSeconds)} ago` : 'never'}</Cell>
                      <Cell className={c.stale ? 'text-alert' : ''}>{c.monitoredPublisherCount === 0 ? 'no sources' : c.stale ? 'stale' : 'fresh'}</Cell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="mt-8">
              <h3 className="m-0 text-[1.05rem] font-semibold">Sources</h3>
              <p className="m-0 text-[0.9rem] text-ink-soft">
                {data.sources.filter((s) => s.withinFreshnessTarget).length} of {data.sources.length} checked successfully within their freshness target.
              </p>
              <div className="overflow-x-auto">
                <table className="tabular mt-2 w-full border-collapse text-left text-[0.92rem]">
                  <thead>
                    <tr className="text-[0.85rem] text-ink-soft">
                      <th className="px-2 py-1 font-normal">Source</th>
                      <th className="px-2 py-1 font-normal">State</th>
                      <th className="px-2 py-1 font-normal">Last success</th>
                      <th className="px-2 py-1 font-normal">Last new article</th>
                      <th className="px-2 py-1 font-normal">Next due</th>
                      <th className="px-2 py-1 font-normal">Failures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.sourceKey}>
                        <Cell>
                          {s.publisher} <span className="text-ink-soft">{s.section}</span> <span className="text-ink-faint">{s.country}</span>
                          {s.lastError && <div className="text-[0.82rem] text-alert">{s.lastError}</div>}
                        </Cell>
                        <Cell className={s.state === 'ok' ? '' : 'text-alert'}>{s.state.replace('_', ' ')}</Cell>
                        <Cell>{relativeTime(s.lastSuccessAt)}</Cell>
                        <Cell>{relativeTime(s.lastNewArticleAt)}</Cell>
                        <Cell>{s.overdueSeconds > 0 ? `overdue ${duration(s.overdueSeconds)}` : relativeTime(s.nextDueAt)}</Cell>
                        <Cell>{s.attemptCount}</Cell>
                      </tr>
                    ))}
                    {data.sources.length === 0 && (
                      <tr>
                        <Cell className="text-ink-soft">No sources are enabled.</Cell>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-8">
              <h3 className="m-0 text-[1.05rem] font-semibold">Recent poll attempts</h3>
              <div className="overflow-x-auto">
                <table className="tabular mt-2 w-full border-collapse text-left text-[0.92rem]">
                  <thead>
                    <tr className="text-[0.85rem] text-ink-soft">
                      <th className="px-2 py-1 font-normal">When</th>
                      <th className="px-2 py-1 font-normal">Source</th>
                      <th className="px-2 py-1 font-normal">Result</th>
                      <th className="px-2 py-1 font-normal">Fetched</th>
                      <th className="px-2 py-1 font-normal">New</th>
                      <th className="px-2 py-1 font-normal">Took</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentRuns.map((r, i) => (
                      <tr key={i}>
                        <Cell>{formatDateTime(r.startedAt)}</Cell>
                        <Cell>{r.sourceKey}</Cell>
                        <Cell className={r.status === 'failed' ? 'text-alert' : ''}>
                          {r.status}
                          {r.error ? `: ${r.error}` : ''}
                        </Cell>
                        <Cell>{r.fetched}</Cell>
                        <Cell>{r.inserted}</Cell>
                        <Cell>{r.durationMs} ms</Cell>
                      </tr>
                    ))}
                    {data.recentRuns.length === 0 && (
                      <tr>
                        <Cell className="text-ink-soft">No poll has run yet.</Cell>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {data.gaps.length > 0 && (
              <section className="mt-8">
                <h3 className="m-0 text-[1.05rem] font-semibold">Recorded coverage gaps</h3>
                <ul className="tabular m-0 mt-2 list-none p-0 text-[0.92rem]">
                  {data.gaps.map((g, i) => (
                    <li key={i} className="border-t border-shore/70 py-1.5">
                      {g.sourceKey}: {formatDateTime(g.start)} to {formatDateTime(g.end)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
