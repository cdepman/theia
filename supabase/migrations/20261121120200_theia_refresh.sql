-- Project Theia: coverage curves, ranking, snapshots, and precomputed views.

-- Cache keys carry the response schema version and the metric version.
create or replace function theia.view_cache_key(p_country text, p_category text, p_window text)
returns text language sql immutable set search_path = '' as $$
  select format('s%s:m%s:%s:%s:%s', 1, 1, p_country, p_category, p_window);
$$;

-- Per-day flags for a country. A day before collection began is unknown, never zero.
-- A day is partial when it is the first collection day, the cutoff day, or overlaps a recorded gap.
create or replace function theia.day_flags(p_country text, p_from date, p_to date, p_cutoff timestamptz)
returns table (day date, known boolean, partial boolean)
language sql stable set search_path = '' as $$
  select g.d,
         c.started is not null and g.d >= c.started_day,
         (c.started is not null and g.d = c.started_day)
           or g.d = (p_cutoff at time zone 'UTC')::date
           or exists (
             select 1 from theia.coverage_gaps cg
              where cg.country_code = p_country
                and cg.gap_start < ((g.d + 1)::timestamp at time zone 'UTC')
                and cg.gap_end >= (g.d::timestamp at time zone 'UTC'))
    from (select gs::date as d from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs) g
   cross join (
     select collection_started_at as started, (collection_started_at at time zone 'UTC')::date as started_day
       from theia.countries where code = p_country) c
   order by g.d;
$$;

-- Pure function over a daily series (oldest first). Unknown days are excluded from
-- every measure. Status and decay use a trailing 3-day mean because daily counts
-- from 15 to 25 outlets are small integers.
create or replace function theia.series_stats(
  p_days date[], p_counts int[], p_known boolean[], p_partial boolean[], p_dormant boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  n int := coalesce(array_length(p_counts, 1), 0);
  i int;
  j int;
  s numeric;
  c int;
  roll numeric[] := '{}';
  peak3 numeric := 0;
  peak3_idx int;
  peak_count int := 0;
  peak_idx int;
  last_idx int;
  active int := 0;
  known_days int := 0;
  last3 int := 0;
  total int := 0;
  status text;
  decay int;
  series jsonb := '[]'::jsonb;
begin
  for i in 1..n loop
    s := 0;
    c := 0;
    for j in greatest(1, i - 2)..i loop
      if p_known[j] then
        s := s + p_counts[j];
        c := c + 1;
      end if;
    end loop;
    roll := array_append(roll, case when c > 0 then s / c end);
    if p_known[i] then
      known_days := known_days + 1;
      total := total + p_counts[i];
      if p_counts[i] > 0 then
        active := active + 1;
        last_idx := i;
      end if;
      if p_counts[i] > peak_count then
        peak_count := p_counts[i];
        peak_idx := i;
      end if;
      if i > n - 3 then
        last3 := last3 + p_counts[i];
      end if;
    end if;
    if roll[i] is not null and roll[i] > peak3 then
      peak3 := roll[i];
      peak3_idx := i;
    end if;
    series := series || jsonb_build_object('day', p_days[i], 'count', case when p_known[i] then p_counts[i] end,
      'known', p_known[i], 'partial', p_known[i] and p_partial[i]);
  end loop;

  if p_dormant then
    status := 'dormant';
  elsif known_days = 0 then
    status := 'unknown';
  elsif last3 > 0 and roll[n] is not null and roll[n] >= peak3 / 2 then
    status := 'active';
  elsif last3 > 0 then
    status := 'fading';
  else
    status := 'quiet';
  end if;

  if peak3_idx is not null then
    for i in (peak3_idx + 1)..n loop
      if roll[i] is not null and roll[i] <= peak3 / 2 then
        decay := i - peak3_idx;
        exit;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', status,
    'publisherDays', total,
    'activeDays', active,
    'knownDays', known_days,
    'peakDay', case when peak_idx is not null then p_days[peak_idx] end,
    'peakCount', peak_count,
    'lastCoverageDay', case when last_idx is not null then p_days[last_idx] end,
    'daysSinceLastCoverage', case when last_idx is not null then n - last_idx end,
    'decayDays', decay,
    'series', series);
end $$;

create or replace function theia.thread_stats(p_thread uuid, p_country text, p_cutoff timestamptz, p_days int default 30)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_to date := (p_cutoff at time zone 'UTC')::date;
  v_from date := (p_cutoff at time zone 'UTC')::date - (p_days - 1);
  v_days date[];
  v_counts int[];
  v_known boolean[];
  v_partial boolean[];
  v_dormant boolean;
begin
  -- A day before collection began is unknown, unless an article published that day was seen
  -- later; then the day is known as a lower bound and marked partial.
  select array_agg(f.day order by f.day),
         array_agg(coalesce(c.distinct_publisher_count, 0) order by f.day),
         array_agg(f.known or coalesce(c.distinct_publisher_count, 0) > 0 order by f.day),
         array_agg(f.partial or not f.known order by f.day)
    into v_days, v_counts, v_known, v_partial
    from theia.day_flags(p_country, v_from, v_to, p_cutoff) f
    left join theia.thread_daily_coverage c
      on c.thread_id = p_thread and c.country_code = p_country and c.day = f.day;
  select t.dormant_at is not null into v_dormant from theia.threads t where t.id = p_thread;
  return theia.series_stats(v_days, v_counts, v_known, v_partial, coalesce(v_dormant, false));
end $$;

-- A story's own series, computed over its articles. A story has few articles, so this is a small bounded read.
create or replace function theia.story_stats(p_story uuid, p_country text, p_cutoff timestamptz, p_days int default 30)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_to date := (p_cutoff at time zone 'UTC')::date;
  v_from date := (p_cutoff at time zone 'UTC')::date - (p_days - 1);
  v_days date[];
  v_counts int[];
  v_known boolean[];
  v_partial boolean[];
begin
  select array_agg(f.day order by f.day),
         array_agg(coalesce(c.pubs, 0) order by f.day),
         array_agg(f.known or coalesce(c.pubs, 0) > 0 order by f.day),
         array_agg(f.partial or not f.known order by f.day)
    into v_days, v_counts, v_known, v_partial
    from theia.day_flags(p_country, v_from, v_to, p_cutoff) f
    left join (
      select (a.effective_at at time zone 'UTC')::date as day, count(distinct a.publisher_id)::int as pubs
        from theia.story_articles sa
        join theia.articles a on a.id = sa.article_id
        join theia.publishers p on p.id = a.publisher_id
       where sa.story_id = p_story and p.country_code = p_country and a.effective_at <= p_cutoff
       group by 1
    ) c on c.day = f.day;
  return theia.series_stats(v_days, v_counts, v_known, v_partial, false);
end $$;

-- Story ranking for one country, category and window.
-- Order: distinct publishers, then articles, then most recent article, then story id.
create or replace function theia.story_window_metrics(p_country text, p_category text, p_start timestamptz, p_cutoff timestamptz)
returns table (story_id uuid, pubs int, arts int, first_at timestamptz, last_at timestamptz, synd boolean, headline text, rk int)
language sql stable set search_path = '' as $$
  select m.story_id, m.pubs, m.arts, m.first_at, m.last_at, m.synd, m.headline,
         (row_number() over (order by m.pubs desc, m.arts desc, m.last_at desc, m.story_id))::int
    from (
      select sa.story_id,
             count(distinct a.publisher_id)::int as pubs,
             count(*)::int as arts,
             min(a.effective_at) as first_at,
             max(a.effective_at) as last_at,
             bool_or(a.syndication_group_id is not null) as synd,
             (array_agg(a.headline_original order by a.effective_at, a.id))[1] as headline
        from theia.articles a
        join theia.publishers p on p.id = a.publisher_id
        join theia.story_articles sa on sa.article_id = a.id
        join theia.stories s on s.id = sa.story_id
       where p.country_code = p_country
         and a.effective_at > p_start and a.effective_at <= p_cutoff
         and (p_category = 'all' or s.category = p_category)
       group by sa.story_id
    ) m;
$$;

-- Thread ranking by publisher-days: each outlet counts once per UTC day it covered the subject.
-- Order: publisher-days, then active days, then distinct publishers, then most recent coverage, then thread id.
create or replace function theia.thread_window_metrics(p_country text, p_category text, p_start timestamptz, p_cutoff timestamptz)
returns table (thread_id uuid, publisher_days int, pubs int, active_days int, arts int, stories int,
               last_at timestamptz, top_story_id uuid, headline text, synd boolean, rk int)
language sql stable set search_path = '' as $$
  with base as (
    select ts.thread_id, sa.story_id, a.publisher_id, a.id, a.headline_original, a.effective_at,
           (a.effective_at at time zone 'UTC')::date as d, a.syndication_group_id
      from theia.articles a
      join theia.publishers p on p.id = a.publisher_id
      join theia.story_articles sa on sa.article_id = a.id
      join theia.thread_stories ts on ts.story_id = sa.story_id
      join theia.threads t on t.id = ts.thread_id
     where p.country_code = p_country
       and a.effective_at > p_start and a.effective_at <= p_cutoff
       and (p_category = 'all' or t.category = p_category)
  ), per_day as (
    select b.thread_id, b.d, count(distinct b.publisher_id)::int as c from base b group by b.thread_id, b.d
  ), days as (
    select pd.thread_id, sum(pd.c)::int as publisher_days, count(*)::int as active_days from per_day pd group by pd.thread_id
  ), tot as (
    select b.thread_id, count(distinct b.publisher_id)::int as pubs, count(*)::int as arts,
           count(distinct b.story_id)::int as stories, max(b.effective_at) as last_at,
           bool_or(b.syndication_group_id is not null) as synd
      from base b group by b.thread_id
  ), story_rank as (
    select b.thread_id, b.story_id,
           (array_agg(b.headline_original order by b.effective_at, b.id))[1] as headline,
           row_number() over (partition by b.thread_id
             order by count(distinct b.publisher_id) desc, count(*) desc, max(b.effective_at) desc, b.story_id) as r
      from base b group by b.thread_id, b.story_id
  )
  select d.thread_id, d.publisher_days, t.pubs, d.active_days, t.arts, t.stories, t.last_at,
         sr.story_id, sr.headline, t.synd,
         (row_number() over (order by d.publisher_days desc, d.active_days desc, t.pubs desc, t.last_at desc, d.thread_id))::int
    from days d
    join tot t on t.thread_id = d.thread_id
    join story_rank sr on sr.thread_id = d.thread_id and sr.r = 1;
$$;

create or replace function theia.build_story_items(p_country text, p_category text, p_start timestamptz, p_cutoff timestamptz, p_limit int)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.story_id, 'unit', 'story', 'rank', m.rk, 'headline', m.headline,
      'language', s.language_code, 'category', s.category,
      'metricValue', m.pubs, 'publisherCount', m.pubs, 'articleCount', m.arts,
      'firstSeenAt', m.first_at, 'lastSeenAt', m.last_at, 'syndicated', m.synd,
      'threadId', ts.thread_id,
      'threadStoryCount', (select count(*) from theia.thread_stories x where x.thread_id = ts.thread_id)
    ) order by m.rk), '[]'::jsonb)
    from theia.story_window_metrics(p_country, p_category, p_start, p_cutoff) m
    join theia.stories s on s.id = m.story_id
    left join theia.thread_stories ts on ts.story_id = m.story_id
   where m.rk <= p_limit;
$$;

create or replace function theia.build_thread_items(p_country text, p_category text, p_start timestamptz, p_cutoff timestamptz, p_limit int)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.thread_id, 'unit', 'thread', 'rank', m.rk, 'headline', m.headline,
      'language', t.language_code, 'category', t.category, 'label', t.label,
      'metricValue', m.publisher_days, 'publisherDays', m.publisher_days,
      'publisherCount', m.pubs, 'activeDays', m.active_days, 'articleCount', m.arts,
      'storyCount', m.stories, 'lastSeenAt', m.last_at, 'syndicated', m.synd,
      'topStoryId', m.top_story_id
    ) || (theia.thread_stats(m.thread_id, p_country, p_cutoff) - 'series' - 'publisherDays' - 'activeDays')
    order by m.rk), '[]'::jsonb)
    from theia.thread_window_metrics(p_country, p_category, p_start, p_cutoff) m
    join theia.threads t on t.id = m.thread_id
   where m.rk <= p_limit;
$$;

-- What we actually observed for a country in a window, and why it may be incomplete.
create or replace function theia.coverage_block(p_country text, p_start timestamptz, p_cutoff timestamptz)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_monitored int;
  v_active int;
  v_failing int;
  v_gaps int;
  v_started timestamptz;
  v_data_as_of timestamptz;
  v_floor int := theia.setting_num('publisher_floor', 10)::int;
  v_reasons text[] := '{}';
  v_status text;
begin
  select count(*) into v_monitored from theia.publishers where country_code = p_country and enabled;
  select count(distinct a.publisher_id) into v_active
    from theia.articles a join theia.publishers p on p.id = a.publisher_id
   where p.country_code = p_country and a.effective_at > p_start and a.effective_at <= p_cutoff;
  select count(*) filter (where s.state = 'needs_attention'), max(s.last_success_at)
    into v_failing, v_data_as_of
    from theia.source_schedules s
    join theia.publisher_feeds f on f.id = s.publisher_feed_id
    join theia.publishers p on p.id = f.publisher_id
   where p.country_code = p_country and p.enabled and f.enabled and s.state <> 'disabled';
  select count(*) into v_gaps from theia.coverage_gaps
   where country_code = p_country and gap_start < p_cutoff and gap_end > p_start;
  select collection_started_at into v_started from theia.countries where code = p_country;

  if v_monitored = 0 then v_reasons := array_append(v_reasons, 'no_sources_enabled'::text); end if;
  if v_monitored > 0 and v_monitored < v_floor then v_reasons := array_append(v_reasons, 'below_publisher_floor'::text); end if;
  if v_started is null then v_reasons := array_append(v_reasons, 'collection_not_started'::text);
  elsif v_started > p_start then v_reasons := array_append(v_reasons, 'window_predates_collection'::text); end if;
  if v_failing > 0 then v_reasons := array_append(v_reasons, 'sources_failing'::text); end if;
  if v_gaps > 0 then v_reasons := array_append(v_reasons, 'coverage_gaps'::text); end if;

  v_status := case
    when v_monitored = 0 then 'no_sources'
    when v_started is null then 'no_data'
    when v_monitored < v_floor then 'limited'
    when array_length(v_reasons, 1) is not null then 'partial'
    else 'complete' end;

  return jsonb_build_object(
    'complete', array_length(v_reasons, 1) is null,
    'status', v_status,
    'reasons', to_jsonb(v_reasons),
    'monitoredPublisherCount', v_monitored,
    'activePublisherCount', v_active,
    'publisherFloor', v_floor,
    'failingSourceCount', v_failing,
    'gapCount', v_gaps,
    'collectionStartedAt', v_started,
    'observedStart', case when v_started is null or v_started > p_cutoff then null else greatest(p_start, v_started) end,
    'observedEnd', case when v_started is null then null else least(p_cutoff, coalesce(v_data_as_of, p_cutoff)) end,
    'dataAsOf', v_data_as_of);
end $$;

-- Recomputes one country: daily coverage, snapshots, and all 30 views (10 categories x 3 windows),
-- against a single observation cutoff, in one transaction. A view is replaced only when the
-- new cutoff is newer than the stored one, so a delayed refresh can never overwrite a newer view.
create or replace function public.theia_refresh_country(
  p_country text, p_cutoff timestamptz default now(), p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_schema_version constant int := 1;
  c_metric_version constant int := 1;
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_target int := theia.setting_num('view_refresh_target_seconds', 14400)::int;
  v_from_day date := (p_cutoff at time zone 'UTC')::date - 31;
  v_win record;
  v_cat text;
  v_start timestamptz;
  v_cov jsonb;
  v_items jsonb;
  v_unit text;
  v_metric text;
  v_payload jsonb;
  v_rows int;
  v_written int := 0;
  v_categories constant text[] := array['all', 'politics', 'business', 'technology', 'science', 'health',
    'entertainment', 'sports', 'environment', 'other'];
begin
  if not exists (select 1 from theia.countries where code = p_country) then
    raise exception 'unknown country %', p_country;
  end if;
  if not pg_try_advisory_xact_lock(hashtext('theia_refresh:' || p_country)) then
    return jsonb_build_object('country', p_country, 'skipped', true, 'reason', 'refresh already running');
  end if;

  -- Daily coverage: recompute the trailing month for this country. Idempotent.
  delete from theia.thread_daily_coverage where country_code = p_country and day >= v_from_day;
  insert into theia.thread_daily_coverage (thread_id, country_code, day, distinct_publisher_count, article_count,
    story_count, coverage_status, computed_at)
  select q.thread_id, p_country, q.d, q.pubs, q.arts, q.stories,
         case when f.partial or not f.known then 'partial' else 'complete' end, v_now
    from (
      select ts.thread_id, (a.effective_at at time zone 'UTC')::date as d,
             count(distinct a.publisher_id)::int as pubs, count(*)::int as arts, count(distinct sa.story_id)::int as stories
        from theia.articles a
        join theia.publishers p on p.id = a.publisher_id
        join theia.story_articles sa on sa.article_id = a.id
        join theia.thread_stories ts on ts.story_id = sa.story_id
       where p.country_code = p_country
         and a.effective_at >= (v_from_day::timestamp at time zone 'UTC') and a.effective_at <= p_cutoff
       group by ts.thread_id, (a.effective_at at time zone 'UTC')::date
    ) q
    join theia.day_flags(p_country, v_from_day, (p_cutoff at time zone 'UTC')::date, p_cutoff) f on f.day = q.d;

  for v_win in
    select * from (values ('24h', interval '24 hours'), ('7d', interval '7 days'), ('30d', interval '30 days')) as w(code, span)
  loop
    v_start := p_cutoff - v_win.span;
    v_cov := theia.coverage_block(p_country, v_start, p_cutoff);

    insert into theia.story_metric_snapshots (story_id, country_code, window_code, window_start, window_end,
      observation_cutoff, observed_at, article_count, distinct_publisher_count, rank, prominence_score,
      metric_version, coverage_status)
    select m.story_id, p_country, v_win.code, v_start, p_cutoff, p_cutoff, v_now, m.arts, m.pubs, m.rk, m.pubs,
           c_metric_version, v_cov->>'status'
      from theia.story_window_metrics(p_country, 'all', v_start, p_cutoff) m
     where m.rk <= 100
    on conflict (story_id, country_code, window_code, observation_cutoff, metric_version) do nothing;

    if v_win.code = '30d' then
      insert into theia.thread_metric_snapshots (thread_id, country_code, window_code, window_start, window_end,
        observation_cutoff, observed_at, publisher_days, distinct_publisher_count, active_days, article_count,
        story_count, rank, metric_version, coverage_status)
      select m.thread_id, p_country, v_win.code, v_start, p_cutoff, p_cutoff, v_now, m.publisher_days, m.pubs,
             m.active_days, m.arts, m.stories, m.rk, c_metric_version, v_cov->>'status'
        from theia.thread_window_metrics(p_country, 'all', v_start, p_cutoff) m
       where m.rk <= 100
      on conflict (thread_id, country_code, window_code, observation_cutoff, metric_version) do nothing;
    end if;

    foreach v_cat in array v_categories loop
      if v_win.code = '30d' then
        v_unit := 'thread';
        v_metric := 'publisher_days';
        v_items := theia.build_thread_items(p_country, v_cat, v_start, p_cutoff, 30);
      else
        v_unit := 'story';
        v_metric := 'distinct_monitored_publishers';
        v_items := theia.build_story_items(p_country, v_cat, v_start, p_cutoff, 30);
      end if;

      v_payload := jsonb_build_object(
        'schemaVersion', c_schema_version,
        'metricVersion', c_metric_version,
        'country', p_country,
        'category', v_cat,
        'window', v_win.code,
        'unit', v_unit,
        'metric', v_metric,
        'windowStart', v_start,
        'observationCutoff', p_cutoff,
        'dataAsOf', v_cov->'dataAsOf',
        'computedAt', v_now,
        'coverage', v_cov - 'dataAsOf',
        'metricRange', jsonb_build_object(
          'min', (select min((i->>'metricValue')::int) from jsonb_array_elements(v_items) i),
          'max', (select max((i->>'metricValue')::int) from jsonb_array_elements(v_items) i)),
        'stories', v_items);

      insert into theia.cached_views as v (cache_key, country_code, category, window_code, payload, observation_cutoff,
        data_as_of, computed_at, expires_at, schema_version, source_coverage_status)
      values (
        theia.view_cache_key(p_country, v_cat, v_win.code),
        p_country, v_cat, v_win.code, v_payload, p_cutoff, (v_cov->>'dataAsOf')::timestamptz, v_now,
        v_now + make_interval(secs => v_target), c_schema_version, v_cov->>'status')
      on conflict (cache_key) do update set
        payload = excluded.payload, observation_cutoff = excluded.observation_cutoff,
        data_as_of = excluded.data_as_of, computed_at = excluded.computed_at, expires_at = excluded.expires_at,
        schema_version = excluded.schema_version, source_coverage_status = excluded.source_coverage_status
      where v.observation_cutoff < excluded.observation_cutoff;
      get diagnostics v_rows = row_count;
      v_written := v_written + v_rows;
    end loop;
  end loop;

  perform public.theia_heartbeat('refresh', jsonb_build_object('country', p_country, 'viewsWritten', v_written), v_now);
  return jsonb_build_object('country', p_country, 'skipped', false, 'viewsWritten', v_written,
    'observationCutoff', p_cutoff);
end $$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'theia\_%'
  loop
    execute format('revoke all on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon, authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;
