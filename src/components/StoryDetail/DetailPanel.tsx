import { useEffect, useRef } from 'react';
import { CATEGORY_LABELS, type Category, COUNTRY_NAMES, type CountryCode, WINDOW_LABELS, type WindowCode } from '../../../shared/constants';
import type { ArticleRef, StoryDetail, ThreadDetail, ViewPayload } from '../../../shared/types';
import { useStory, useThread } from '../../lib/api/client';
import { formatDate, formatDateTime, formatDay, languageName, plural } from '../../lib/format';
import { CoverageSparkline } from '../CoverageSparkline/CoverageSparkline';
import { STATUS_TEXT, StatusMark } from '../HeadlineCloud/StatusMark';

export type Selection = { kind: 'story' | 'thread'; id: string };

interface Props {
  selection: Selection;
  country: CountryCode;
  window: WindowCode;
  view: ViewPayload | undefined;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.8rem] text-ink-soft">{label}</dt>
      <dd className="tabular m-0 text-[1.05rem] leading-snug">{children}</dd>
    </div>
  );
}

function SourceRow({ article, country, showCountry }: { article: ArticleRef; country: CountryCode; showCountry: boolean }) {
  const foreign = article.publisher.country !== country;
  return (
    <li className="border-t border-shore/70 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem] text-ink-soft">
        <span className="font-semibold text-ink">{article.publisher.name}</span>
        <span>{article.publisher.domain}</span>
        {(showCountry || foreign) && article.publisher.country && <span>{COUNTRY_NAMES[article.publisher.country as CountryCode] ?? article.publisher.country}</span>}
        {article.publisher.isWire && <span>wire service</span>}
      </div>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        lang={article.language}
        className="mt-0.5 block text-[1.02rem] leading-snug text-ink underline decoration-shore underline-offset-[3px] hover:text-cobalt hover:decoration-cobalt"
      >
        {article.headline}
      </a>
      <div className="tabular mt-1 text-[0.8rem] text-ink-faint">
        {article.publishedAt ? `Published ${formatDateTime(article.publishedAt)}` : 'No publication date in the feed'}
        {`, first seen ${formatDateTime(article.firstObservedAt)}`}
        {article.language !== 'en' ? `, ${languageName(article.language)}` : ''}
        {article.syndicationGroupId ? ', likely syndicated copy' : ''}
      </div>
    </li>
  );
}

function StoryBody({ story, country, window, view, onSelect }: { story: StoryDetail; country: CountryCode; window: WindowCode; view: ViewPayload | undefined; onSelect: Props['onSelect'] }) {
  const counts = story.windows[window];
  const monitored = view?.coverage.monitoredPublisherCount ?? null;
  const name = COUNTRY_NAMES[country];
  const others = story.byCountry.filter((c) => c.country !== country);
  const anySyndicated = story.articles.items.some((a) => a.syndicationGroupId);
  return (
    <>
      <p className="mt-3 text-[0.98rem] leading-relaxed">
        <span className="tabular font-semibold">
          {counts.publisherCount} of {monitored ?? 'the'} monitored {name} {monitored === 1 ? 'publisher' : 'publishers'}
        </span>{' '}
        reported this in the last {WINDOW_LABELS[window]}, in {plural(counts.articleCount, 'article')}. Rank and size come from the publisher count alone; several
        articles from one outlet count once.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label="First reported">{formatDateTime(story.firstSeenAt)}</Fact>
        <Fact label="Latest article">{formatDateTime(story.lastSeenAt)}</Fact>
        <Fact label="Category">{CATEGORY_LABELS[story.category as Category] ?? story.category}</Fact>
        <Fact label="Language">{languageName(story.language)}</Fact>
      </dl>
      {others.length > 0 && (
        <p className="mt-3 text-[0.9rem] text-ink-soft">
          Also reported by monitored publishers in{' '}
          {others.map((c) => `${COUNTRY_NAMES[c.country as CountryCode] ?? c.country} (${c.publisherCount})`).join(', ')}. Those do not count toward the {name} figure.
        </p>
      )}

      <h3 className="mt-6 text-[1rem] font-semibold">Coverage by day in {name}</h3>
      <div className="mt-2">
        <CoverageSparkline series={story.stats.series} countryName={name} />
      </div>

      {story.thread && story.thread.storyCount > 1 && (
        <p className="mt-5 rounded-sm bg-cobalt-wash px-3 py-2 text-[0.92rem]">
          One of {story.thread.storyCount} linked stories on a longer-running subject.{' '}
          <button type="button" className="cursor-pointer text-cobalt underline underline-offset-[3px]" onClick={() => onSelect({ kind: 'thread', id: story.thread!.id })}>
            See the whole subject
          </button>
        </p>
      )}

      <h3 className="mt-6 text-[1rem] font-semibold">Original reporting</h3>
      <p className="text-[0.85rem] text-ink-soft">
        Headlines are shown as published and link to the publisher.{anySyndicated ? ' Syndicated copies still count toward the publisher total.' : ''}
      </p>
      <ul className="m-0 mt-2 list-none p-0">
        {story.articles.items.map((a) => (
          <SourceRow key={a.id} article={a} country={country} showCountry={others.length > 0} />
        ))}
      </ul>
      {story.articles.total > story.articles.items.length && (
        <p className="mt-2 text-[0.85rem] text-ink-soft">Showing {story.articles.items.length} of {story.articles.total} articles.</p>
      )}
    </>
  );
}

function ThreadBody({ thread, country, onSelect }: { thread: ThreadDetail; country: CountryCode; onSelect: Props['onSelect'] }) {
  const name = COUNTRY_NAMES[country];
  const s = thread.stats;
  return (
    <>
      <p className="mt-3 flex items-center gap-2 text-[0.98rem]">
        <StatusMark status={s.status} size={13} />
        <span>
          {STATUS_TEXT[s.status]} in {name}.
        </span>
      </p>
      <p className="mt-2 text-[0.98rem] leading-relaxed">
        {plural(thread.storyCount, 'linked story', 'linked stories')} since {formatDate(thread.firstSeenAt)}. Over the last 30 days this subject earned{' '}
        <span className="tabular font-semibold">{plural(s.publisherDays, 'publisher-day')}</span> in {name}: each monitored outlet counts once for every day it covered
        the subject. That figure sets its rank and size.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label="Days with coverage">
          {s.activeDays} of {s.knownDays} known
        </Fact>
        <Fact label="Peak day">{s.peakDay ? `${formatDay(s.peakDay)} (${s.peakCount})` : 'none yet'}</Fact>
        <Fact label="Last covered">
          {s.daysSinceLastCoverage === null ? 'not in this period' : s.daysSinceLastCoverage === 0 ? 'today' : `${plural(s.daysSinceLastCoverage, 'day')} ago`}
        </Fact>
        <Fact label="Fell to half its peak">{s.decayDays === null ? 'not yet' : `after ${plural(s.decayDays, 'day')}`}</Fact>
      </dl>

      <h3 className="mt-6 text-[1rem] font-semibold">Coverage by day in {name}</h3>
      <div className="mt-2">
        <CoverageSparkline series={s.series} countryName={name} />
      </div>
      {thread.byCountry.filter((c) => c.country !== country).length > 0 && (
        <p className="mt-3 text-[0.9rem] text-ink-soft">
          Elsewhere over the same 30 days:{' '}
          {thread.byCountry
            .filter((c) => c.country !== country)
            .map((c) => `${COUNTRY_NAMES[c.country as CountryCode] ?? c.country}, ${plural(c.publisherDays, 'publisher-day')} over ${plural(c.activeDays, 'day')}`)
            .join('; ')}
          .
        </p>
      )}

      <h3 className="mt-6 text-[1rem] font-semibold">Stories in this subject</h3>
      <ol className="m-0 mt-2 list-none p-0">
        {thread.stories.map((st) => (
          <li key={st.id} className="grid grid-cols-[4.2rem_1fr] gap-x-3 border-t border-shore/70 py-3 first:border-t-0">
            <span className="tabular pt-[0.15em] text-[0.85rem] text-ink-soft">{formatDate(st.firstSeenAt)}</span>
            <span>
              <button
                type="button"
                lang={thread.language}
                onClick={() => onSelect({ kind: 'story', id: st.id })}
                className="cursor-pointer text-left text-[1.02rem] leading-snug text-ink underline decoration-shore underline-offset-[3px] hover:text-cobalt hover:decoration-cobalt"
              >
                {st.headline}
              </button>
              <span className="tabular mt-0.5 block text-[0.8rem] text-ink-faint">
                {plural(st.publisherCount, `${name} publisher`)}, {plural(st.articleCount, 'article')} in all
              </span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-[0.82rem] text-ink-faint">
        Stories are linked when they share at least two distinctive terms. Shared terms for this subject: {thread.signatureTerms.slice(0, 6).join(', ') || 'none recorded'}.
        Linking is automatic and conservative, and it can be wrong.
      </p>
    </>
  );
}

/** Story or thread detail. A side panel on wide screens and a bottom sheet on narrow ones. */
export function DetailPanel({ selection, country, window, view, onSelect, onClose }: Props) {
  const story = useStory(selection.kind === 'story' ? selection.id : null, country);
  const thread = useThread(selection.kind === 'thread' ? selection.id : null, country);
  const query = selection.kind === 'story' ? story : thread;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the panel when it opens or changes, so keyboard and screen-reader users land on the content.
  useEffect(() => {
    headingRef.current?.focus();
  }, [selection.id, query.isSuccess]);

  const listed = view?.stories.find((s) => s.id === selection.id);
  const headline =
    selection.kind === 'story' ? (listed?.shortLabel ?? story.data?.headline ?? listed?.headline) : (listed?.shortLabel ?? listed?.headline ?? thread.data?.stories[thread.data.stories.length - 1]?.headline);
  const language = (selection.kind === 'story' ? story.data?.language : thread.data?.language) ?? listed?.language;

  return (
    <>
      <button type="button" aria-label="Close details" onClick={onClose} className="fixed inset-0 z-10 cursor-default bg-ink/25 md:hidden" tabIndex={-1} />
      <aside
        aria-label={selection.kind === 'story' ? 'Story details' : 'Subject details'}
        className="detail-enter fixed inset-x-0 bottom-0 z-20 max-h-[82vh] overflow-y-auto rounded-t-xl bg-paper px-5 pb-8 pt-4 shadow-[0_-8px_30px_rgba(20,34,56,0.18)] md:absolute md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[26.5rem] md:rounded-none md:border-l md:border-shore md:px-6 md:pt-5 md:shadow-[-12px_0_32px_rgba(20,34,56,0.10)]"
      >
        <div className="flex items-start justify-between gap-4">
          <p className="m-0 text-[0.85rem] text-ink-soft">{selection.kind === 'story' ? 'Story' : 'Subject, linked across stories'}</p>
          <button type="button" onClick={onClose} className="-mr-1 -mt-1 cursor-pointer rounded-sm px-2 py-1 text-[0.9rem] text-ink-soft hover:bg-sea hover:text-ink">
            Close
          </button>
        </div>
        <h2 ref={headingRef} tabIndex={-1} lang={language} className="mt-1 text-[1.55rem] font-medium leading-[1.14] tracking-[-0.015em] outline-none">
          {headline ?? (query.isPending ? 'Loading' : 'Details')}
        </h2>
        {query.isPending && <p className="mt-4 text-ink-soft">Loading sources.</p>}
        {query.isError && (
          <p className="mt-4 rounded-sm bg-alert-wash px-3 py-2 text-alert" role="alert">
            These details could not be loaded.{' '}
            <button type="button" className="cursor-pointer underline" onClick={() => void query.refetch()}>
              Try again
            </button>
          </p>
        )}
        {selection.kind === 'story' && story.data && <StoryBody story={story.data} country={country} window={window} view={view} onSelect={onSelect} />}
        {selection.kind === 'thread' && thread.data && <ThreadBody thread={thread.data} country={country} onSelect={onSelect} />}
      </aside>
    </>
  );
}
