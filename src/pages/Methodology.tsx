import { COUNTRIES, COUNTRY_NAMES, type CountryCode } from '../../shared/constants';
import { PageHeader } from '../App';
import { useCoverage, useMeta } from '../lib/api/client';
import { formatDateTime, relativeTime } from '../lib/format';

function CountrySources({ country }: { country: CountryCode }) {
  const { data, isPending, isError } = useCoverage(country);
  if (isPending) return <p className="text-ink-soft">Loading the {COUNTRY_NAMES[country]} source list.</p>;
  if (isError || !data) return <p className="text-alert">The {COUNTRY_NAMES[country]} source list could not be loaded.</p>;
  const enabled = data.publishers.filter((p) => p.enabled);
  const disabled = data.publishers.filter((p) => !p.enabled);
  const lastCheck = enabled
    .flatMap((p) => p.feeds.map((f) => f.lastSuccessAt))
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  return (
    <section className="mb-6">
      <h3 className="m-0 text-[1.1rem] font-semibold">{COUNTRY_NAMES[country]}</h3>
      <p className="tabular m-0 text-[0.9rem] text-ink-soft">
        {enabled.length} monitored, {disabled.length} recorded but not monitored.{' '}
        {data.collectionStartedAt ? `Collection began ${formatDateTime(data.collectionStartedAt)}.` : 'Collection has not started.'}{' '}
        {lastCheck ? `Last successful check ${relativeTime(lastCheck)}.` : ''}
      </p>
      {enabled.length > 0 ? (
        <ul className="m-0 mt-2 list-none p-0">
          {enabled.map((p) => (
            <li key={p.domain} className="flex flex-wrap items-baseline gap-x-2 border-t border-shore/70 py-1.5 text-[0.95rem]">
              <span className="font-semibold">{p.name}</span>
              <span className="text-ink-soft">{p.domain}</span>
              <span className="text-ink-soft">{p.languages.join(', ')}</span>
              {p.isWire && <span className="text-ink-soft">wire service</span>}
              <span className="tabular ml-auto text-ink-soft">{p.articleCount30d} articles in 30 days</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[0.95rem]">No publisher is monitored for this country yet, so its views are empty.</p>
      )}
      {disabled.length > 0 && (
        <p className="mt-2 text-[0.85rem] text-ink-faint">Not monitored (terms not yet reviewed, or feed unavailable): {disabled.map((p) => p.name).join(', ')}.</p>
      )}
      {data.gaps.length > 0 && (
        <p className="mt-2 text-[0.85rem] text-ink-soft">
          {data.gaps.length} recorded coverage {data.gaps.length === 1 ? 'gap' : 'gaps'} in the last 30 days, most recently {formatDateTime(data.gaps[0]!.start)} to{' '}
          {formatDateTime(data.gaps[0]!.end)}.
        </p>
      )}
    </section>
  );
}

export function Methodology() {
  const meta = useMeta();
  return (
    <div className="min-h-full">
      <PageHeader />
      <main className="prose-theia mx-auto max-w-[46rem] px-5 pb-16 pt-8 md:px-8">
        <h2 className="!mt-0 text-[2rem] !font-medium leading-tight tracking-[-0.02em]">How to read Project Theia</h2>
        <p className="text-[1.1rem]">
          Theia shows what a fixed, named set of news publishers in each country is reporting. It measures reporting observed from those publishers. It does not measure
          what people in that country read, watch, or believe.
        </p>

        <h2>Three things that are easy to confuse</h2>
        <ul>
          <li>
            <strong>Publisher country</strong> is where an outlet is based. This is the only geography Theia uses. Each outlet is assigned to a country by hand, in the
            source registry.
          </li>
          <li>
            <strong>Event location</strong> is where something happened. A Japanese outlet reporting on Washington counts toward Japan.
          </li>
          <li>
            <strong>Audience location</strong> is where readers are. Theia knows nothing about audiences.
          </li>
        </ul>

        <h2>What headline size means</h2>
        <p>
          In the 24 hour and 7 day views each headline is a <strong>story</strong>: one event or development. Its size reflects the number of distinct monitored
          publishers from the selected country that published at least one article on it inside the window. Ten articles from one outlet count once. Ties are broken by
          article count, then by the most recent article.
        </p>
        <p>
          In the 30 day view each headline is a <strong>subject</strong>: a thread linking related stories over time. Its size reflects <strong>publisher-days</strong>,
          which counts each outlet once for every day it covered the subject. A plain publisher count saturates over a month, since a one-day event and a month-long
          conflict can both reach every outlet. Publisher-days separates them.
        </p>
        <p>
          Sizes come in a few discrete steps across the range seen in the current view. When every item has the same count, all are drawn at one size. Size never means
          readership, popularity, importance, or engagement.
        </p>

        <h2>Whether a subject sustains or fades</h2>
        <p>
          For each subject and country Theia keeps a daily count of distinct publishers, by UTC day. From that it reports the peak day, the days with coverage, the days
          since the last coverage, and a status. A subject is <em>still being covered</em> when its average over the last three days is at least half its best
          three-day average, <em>fading</em> when it is covered but below that, <em>quiet</em> after three days without coverage, and <em>dormant</em> after 21 days
          without any new article. A dormant subject reopens if a new story links to it within 90 days.
        </p>
        <p>
          Days before collection began and days inside a recorded coverage gap are unknown. They are drawn as dotted gaps and excluded from publisher-days, decay,
          and status; they are never shown as zero. A pre-collection day with an article seen later is a partial lower bound, unless it also falls in a recorded gap.
          The first day of collection and the boundary days of the rolling window are partial. Thirty elapsed days can span 31 UTC dates. With a small set of
          outlets the daily counts are small numbers, so a change of one or two publishers is not a trend.
        </p>

        <h2>How articles become stories and subjects</h2>
        <ul>
          <li>
            <strong>Collection.</strong> Each monitored RSS feed is checked about every three hours. Only the headline, link, publication date, and the feed's own short
            summary are stored. Article text is never fetched.
          </li>
          <li>
            <strong>De-duplication.</strong> Tracking parameters are removed from links and each link is stored once. The time Theia first saw an article is recorded
            and never changed.
          </li>
          <li>
            <strong>Stories.</strong> Within one language, an article joins the open story whose headlines it most resembles, if the resemblance clears a threshold;
            otherwise it starts a new story. A story stops accepting articles 72 hours after its last one. English is compared by words and word pairs, Japanese by
            character pairs. Stories are never merged across languages.
          </li>
          <li>
            <strong>Subjects.</strong> A new story is linked to an existing subject only when the two share at least two distinctive terms, such as two different names.
            One shared name is never enough. This is deliberately conservative: a missed link understates how long a subject ran, while a false link would invent
            endurance.
          </li>
          <li>
            <strong>Categories</strong> come from the feed's section where there is one, then from fixed keyword lists. Anything uncertain is "Other".
          </li>
          <li>
            <strong>Syndicated copy.</strong> Near-identical headlines from different outlets within a day are flagged as likely syndicated. They still count toward
            the publisher total, because each outlet chose to run the story.
          </li>
        </ul>

        <h2>Known limits</h2>
        <ul>
          <li>The source set is small and hand-picked. It is not a representative sample of a national press, and a country with few monitored outlets is labelled as limited.</li>
          <li>
            Story matching was tuned on 131 labelled headline pairs from a single day of feeds. At the chosen thresholds it scored 93% precision and 74% recall for
            English, and 95% precision and 66% recall for Japanese, on those same pairs. Expect some split stories and occasional wrong merges.
          </li>
          <li>
            Subject linking has not yet been measured against labelled data, because that needs several weeks of collected history. Treat subject links as provisional.
          </li>
          <li>Subjects are linked within one language only. A Japanese-language subject and an English-language subject about the same events appear separately.</li>
          <li>Japanese headlines are shown in Japanese. There is no translation.</li>
          <li>RSS feeds only list recent items. If Theia is offline longer than a feed retains items, the missed interval is recorded as a gap, not filled in.</li>
        </ul>

        <h2>Sources and attribution</h2>
        <p>
          Every headline links to the publisher's own page and is shown as published. The lists below are the complete monitored set, read live from the database.
          {meta.data ? ` A country needs ${meta.data.publisherFloor} monitored publishers before its coverage is treated as more than limited.` : ''}
        </p>
        {COUNTRIES.map((c) => (
          <CountrySources key={c} country={c} />
        ))}
        <p className="text-[0.85rem] text-ink-faint">
          Country outlines are drawn from Natural Earth public-domain data. Publisher names and headlines belong to their publishers.
        </p>
      </main>
    </div>
  );
}
