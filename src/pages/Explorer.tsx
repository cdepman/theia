import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  CATEGORY_LABELS, type Category, COUNTRY_NAMES, type CountryCode, DEFAULT_CATEGORY, DEFAULT_COUNTRY, DEFAULT_WINDOW, isCategory, isCountry, isWindow,
  WINDOW_LABELS, type WindowCode,
} from '../../shared/constants';
import type { ViewItem, ViewPayload } from '../../shared/types';
import { PageHeader } from '../App';
import { Filters } from '../components/Filters/Filters';
import { HeadlineCloud } from '../components/HeadlineCloud/HeadlineCloud';
import { SizeLegend } from '../components/HeadlineCloud/SizeLegend';
import { DetailPanel, type Selection } from '../components/StoryDetail/DetailPanel';
import { prefetchAdjacent, useView } from '../lib/api/client';
import { reasonText, relativeTime } from '../lib/format';
import { Link, useQueryParams } from '../lib/router';

function parseSelection(value: string | null): Selection | null {
  const m = /^(story|thread):([0-9a-f-]{36})$/i.exec(value ?? '');
  return m ? { kind: m[1] as Selection['kind'], id: m[2]! } : null;
}

/** States the limits of what is shown, whenever there are any. */
function CoverageNote({ view }: { view: ViewPayload }) {
  const notes: string[] = [];
  if (view.freshness?.stale) notes.push(`This view was last computed ${relativeTime(view.freshness.computedAt)} and is past its refresh target.`);
  for (const r of view.coverage.reasons) notes.push(reasonText(r));
  if (notes.length === 0) return null;
  const serious = Boolean(view.freshness?.stale) || view.coverage.reasons.includes('sources_failing');
  return (
    <div role={serious ? 'alert' : 'note'} className={`rounded-sm px-3 py-1.5 text-[0.88rem] ${serious ? 'bg-alert-wash text-alert' : 'bg-sea-deep text-ink-soft'}`}>
      <span className="font-semibold">{view.freshness?.stale ? 'Stale. ' : 'Partial coverage. '}</span>
      {notes.join(' ')}{' '}
      <Link href="/methodology" className="underline underline-offset-[3px]">
        How to read this
      </Link>
    </div>
  );
}

function EmptyState({ view }: { view: ViewPayload }) {
  const country = COUNTRY_NAMES[view.country];
  let title = `No ${view.category === 'all' ? '' : `${CATEGORY_LABELS[view.category].toLowerCase()} `}stories in the last ${WINDOW_LABELS[view.window]}`;
  let body = `None of the monitored ${country} publishers has an article in this category and window. Try a longer window or another category.`;
  if (view.coverage.status === 'no_sources') {
    title = `No sources are enabled for ${country}`;
    body = 'Enable publishers in config/source-activation.json, run "npm run registry:sync", then run the pipeline. Nothing is shown until real articles are collected.';
  } else if (view.notComputed || view.coverage.status === 'no_data') {
    title = `Nothing collected yet for ${country}`;
    body = 'The pipeline has not completed a run for this country. Run "npm run pipeline", or wait for the next scheduled run.';
  }
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-[34rem] rounded-sm bg-paper/80 px-6 py-5">
        <h2 className="m-0 text-[1.4rem] font-medium leading-tight tracking-[-0.01em]">{title}</h2>
        <p className="mb-0 mt-2 text-ink-soft">{body}</p>
      </div>
    </div>
  );
}

export function Explorer() {
  const [params, setParams] = useQueryParams();
  const country: CountryCode = isCountry(params.get('country')) ? (params.get('country') as CountryCode) : DEFAULT_COUNTRY;
  const category: Category = isCategory(params.get('category')) ? (params.get('category') as Category) : DEFAULT_CATEGORY;
  const window: WindowCode = isWindow(params.get('window')) ? (params.get('window') as WindowCode) : DEFAULT_WINDOW;
  const selection = parseSelection(params.get('item'));

  const query = useView(country, category, window);
  const view = query.data;
  const client = useQueryClient();

  useEffect(() => {
    if (query.isSuccess) prefetchAdjacent(client, country, category, window);
  }, [client, query.isSuccess, country, category, window]);

  useEffect(() => {
    document.title = `${COUNTRY_NAMES[country]}, ${WINDOW_LABELS[window]} | Project Theia`;
  }, [country, window]);

  const asList = params.get('layout') === 'list';
  const [drawn, setDrawn] = useState<{ mode: 'cloud' | 'list'; shown: number; total: number } | null>(null);

  const select = useCallback((s: Selection | null) => setParams({ item: s ? `${s.kind}:${s.id}` : null }), [setParams]);
  const onItem = useCallback((item: ViewItem) => select(selection?.id === item.id ? null : { kind: item.unit, id: item.id }), [select, selection?.id]);
  const close = useCallback(() => select(null), [select]);

  // The view on screen may briefly be the previous one while the next loads.
  const showing = view && view.country === country && view.category === category && view.window === window;

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <span className="tabular hidden text-ink-soft md:inline" aria-live="polite">
          {view?.dataAsOf ? `Sources checked ${relativeTime(view.dataAsOf)}` : view ? 'No sources checked yet' : ''}
        </span>
      </PageHeader>
      <div className="px-5 pb-2 pt-3 md:px-8">
        <Filters
          country={country}
          category={category}
          window={window}
          onChange={(c) => setParams({ ...(c.country ? { country: c.country } : {}), ...(c.category ? { category: c.category } : {}), ...(c.window ? { window: c.window } : {}), item: null })}
        />
      </div>

      <main className="relative flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col px-5 pb-3 md:px-8" aria-busy={query.isFetching}>
          <h2 className="sr-only">
            {view?.unit === 'thread' ? 'Subjects' : 'Stories'} reported by monitored {COUNTRY_NAMES[country]} publishers, last {WINDOW_LABELS[window]}
          </h2>
          {view && showing && <CoverageNote view={view} />}
          <div className={`relative min-h-0 flex-1 ${showing || !view ? '' : 'opacity-50'}`}>
            {query.isPending && <p className="grid h-full place-items-center text-ink-soft">Loading the latest view.</p>}
            {query.isError && !view && (
              <div className="grid h-full place-items-center">
                <p className="max-w-[32rem] rounded-sm bg-alert-wash px-4 py-3 text-alert" role="alert">
                  The view could not be loaded: {query.error.message}.{' '}
                  <button type="button" className="cursor-pointer underline" onClick={() => void query.refetch()}>
                    Try again
                  </button>
                </p>
              </div>
            )}
            {view && view.stories.length === 0 && <EmptyState view={view} />}
            {view && view.stories.length > 0 && <HeadlineCloud view={view} selectedId={selection?.id ?? null} onSelect={onItem} asList={asList} onLayout={setDrawn} />}
          </div>
          {view && view.stories.length > 0 && (
            <footer className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-shore pt-2">
              <SizeLegend view={view} />
              <p className="m-0 hidden text-[0.85rem] text-ink-soft md:block">
                {drawn && drawn.mode === 'cloud' && drawn.shown < drawn.total ? `The top ${drawn.shown} of ${drawn.total} fit here. ` : ''}
                <button type="button" className="cursor-pointer underline underline-offset-[3px] hover:text-ink" onClick={() => setParams({ layout: asList ? null : 'list' })}>
                  {asList ? 'Show as a cloud' : `Show all ${view.stories.length} as a ranked list`}
                </button>
              </p>
              <p className="tabular m-0 text-[0.85rem] text-ink-soft">
                <span className="md:hidden">{view.dataAsOf ? `Sources checked ${relativeTime(view.dataAsOf)}. ` : ''}</span>
                {view.unit === 'thread' ? 'Showing subjects that link related stories. ' : ''}
                {view.coverage.monitoredPublisherCount} monitored {view.coverage.monitoredPublisherCount === 1 ? 'publisher' : 'publishers'},{' '}
                {view.coverage.activePublisherCount} with articles in this window. Publisher country, not audience or event location.
              </p>
            </footer>
          )}
        </section>
        {selection && <DetailPanel selection={selection} country={country} window={window} view={showing ? view : undefined} onSelect={select} onClose={close} />}
      </main>
    </div>
  );
}
