-- Review fixes: preserve thread history, recover interrupted work, and keep coverage
-- and rolling-window statistics consistent. Apply after the original four migrations.
-- Existing snapshots are never rewritten; corrected metrics appear at the next cutoff.

alter table theia.threads
  add column merged_into_id uuid references theia.threads (id),
  add constraint threads_no_self_merge check (merged_into_id <> id);
create index threads_merged_into_idx on theia.threads (merged_into_id) where merged_into_id is not null;

-- A historical identity must outlive every snapshot that references it.
alter table theia.thread_metric_snapshots drop constraint thread_metric_snapshots_thread_id_fkey;
alter table theia.thread_metric_snapshots add constraint thread_metric_snapshots_thread_id_fkey
  foreign key (thread_id) references theia.threads (id) on delete restrict;

create or replace function theia.resolve_thread(p_thread uuid)
returns uuid language sql stable set search_path = '' as $$
  with recursive chain as (
    select t.id, t.merged_into_id, array[t.id] as visited from theia.threads t where t.id = p_thread
    union all
    select t.id, t.merged_into_id, c.visited || t.id
      from chain c join theia.threads t on t.id = c.merged_into_id
     where not (t.id = any(c.visited))
  )
  select id from chain where merged_into_id is null;
$$;

-- Gap intervals are half-open. Only the portion of the day inside the observation
-- window can be unknown; a gap beginning after the cutoff cannot affect this view.
create or replace function theia.day_has_gap(p_country text, p_day date, p_cutoff timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from theia.coverage_gaps g
     where g.country_code = p_country
       and g.gap_start < least(((p_day + 1)::timestamp at time zone 'UTC'), p_cutoff)
       and g.gap_end > (p_day::timestamp at time zone 'UTC'));
$$;

-- Recovery includes both unassigned articles and unfinished thread decisions.

create or replace function public.theia_pending_languages(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(q.language_code order by q.language_code), '[]'::jsonb)
    from (
      select distinct a.language_code
        from theia.articles a
       where not exists (select 1 from theia.story_articles sa where sa.article_id = a.id)
      union
      select s.language_code
        from theia.stories s left join theia.thread_stories ts on ts.story_id = s.id
       where ts.story_id is null
          or (s.closed_at is null and s.updated_at > ts.evaluated_at
              and (select count(*) from theia.thread_stories x where x.thread_id = ts.thread_id) = 1)
    ) q;
$$;

create or replace function public.theia_threading_input(
  p_language text, p_now timestamptz default now(), p_limit int default 2000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dormancy int := theia.setting_num('thread_dormancy_days', 21)::int;
  v_result jsonb;
begin
  update theia.threads set dormant_at = p_now, updated_at = p_now
   where dormant_at is null and last_seen_at < p_now - make_interval(days => v_dormancy);

  select coalesce(jsonb_agg(q.obj), '[]'::jsonb) into v_result
    from (
      select jsonb_build_object(
          'id', s.id,
          'threadId', ts.thread_id,
          'firstSeenAt', s.first_seen_at,
          'lastSeenAt', s.last_seen_at,
          'texts', (
            select coalesce(jsonb_agg(jsonb_build_object('h', m.headline_original, 'n', m.headline_normalized, 's', m.summary)), '[]'::jsonb)
              from (
                select a.headline_original, a.headline_normalized, a.summary
                  from theia.story_articles sa join theia.articles a on a.id = sa.article_id
                 where sa.story_id = s.id
                 order by a.effective_at
                 limit 12
              ) m)
        ) as obj
        from theia.stories s
        left join theia.thread_stories ts on ts.story_id = s.id
       where s.language_code = p_language
         and (
           ts.story_id is null
           or (s.closed_at is null and s.updated_at > ts.evaluated_at
               and (select count(*) from theia.thread_stories t2 where t2.thread_id = ts.thread_id) = 1)
         )
       order by s.first_seen_at, s.id
       limit p_limit
    ) q;

  return jsonb_build_object('language', p_language, 'stories', v_result,
    'countries', (select coalesce(jsonb_agg(distinct p.country_code), '[]'::jsonb)
      from theia.publishers p where p_language = any(p.languages) and p.country_code is not null));
end $$;

create or replace function public.theia_thread_candidates(
  p_language text, p_signatures jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reopen int := theia.setting_num('thread_reopen_days', 90)::int;
  v_result jsonb;
begin
  with sig as (
    select (e->>'storyId')::uuid as story_id, t.term
      from jsonb_array_elements(coalesce(p_signatures, '[]'::jsonb)) e,
           jsonb_array_elements_text(e->'terms') as t(term)
  ), hits as (
    select sig.story_id, tt.thread_id, count(*) as shared
      from sig
      join theia.thread_terms tt on tt.term = sig.term
      join theia.threads th on th.id = tt.thread_id
     where th.language_code = p_language and th.merged_into_id is null
       and th.last_seen_at > p_now - make_interval(days => v_reopen)
       and not exists (select 1 from theia.thread_stories x where x.thread_id = th.id and x.story_id = sig.story_id)
     group by sig.story_id, tt.thread_id
    having count(*) >= 2
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'storyId', h.story_id, 'threadId', th.id, 'shared', h.shared, 'signature', th.signature,
      'lastSeenAt', th.last_seen_at, 'dormant', th.dormant_at is not null,
      'storyCount', (select count(*) from theia.thread_stories x where x.thread_id = th.id)
    )), '[]'::jsonb) into v_result
    from hits h join theia.threads th on th.id = h.thread_id;
  return v_result;
end $$;

create or replace function public.theia_apply_threading(
  p_language text, p_payload jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int := coalesce((p_payload->>'threadVersion')::int, 1);
  v_map jsonb := '{}'::jsonb;
  v_item jsonb;
  v_id uuid;
  v_story uuid;
  v_target uuid;
  v_current uuid;
  v_dormant timestamptz;
  v_touched uuid[] := '{}';
  v_linked int := 0;
  v_created int := 0;
  v_reignited int := 0;
begin
  -- Serialize membership changes; a stale plan resolves retired targets below.
  perform pg_advisory_xact_lock(hashtext('theia_threading:' || p_language));
  for v_item in select * from jsonb_array_elements(coalesce(p_payload->'newThreads', '[]'::jsonb)) loop
    insert into theia.threads (language_code, label, signature, first_seen_at, last_seen_at, thread_version, created_at, updated_at)
    values (p_language, left(coalesce(v_item->>'label', ''), 200), coalesce(v_item->'signature', '{}'::jsonb), p_now, p_now, v_version, p_now, p_now)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(v_item->>'key', v_id);
    v_created := v_created + 1;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload->'links', '[]'::jsonb)) loop
    v_story := (v_item->>'storyId')::uuid;
    v_target := coalesce(nullif(v_item->>'threadId', '')::uuid, (v_map->>(v_item->>'threadKey'))::uuid);
    v_target := theia.resolve_thread(v_target);
    continue when v_target is null or not exists (select 1 from theia.stories where id = v_story);
    continue when not exists (select 1 from theia.threads where id = v_target);

    select thread_id into v_current from theia.thread_stories where story_id = v_story;
    if v_current is not null and v_current = v_target then
      continue;
    end if;

    if v_current is null then
      insert into theia.thread_stories (thread_id, story_id, linked_at, evaluated_at, link_method, link_score, thread_version)
      values (v_target, v_story, p_now, p_now, v_item->>'method', (v_item->>'score')::numeric, v_version)
      on conflict (story_id) do nothing;
    else
      -- Only a thread of one may be folded into another thread.
      continue when (select count(*) from theia.thread_stories where thread_id = v_current) <> 1;
      update theia.thread_stories
         set thread_id = v_target, linked_at = p_now, evaluated_at = p_now,
             link_method = v_item->>'method', link_score = (v_item->>'score')::numeric, thread_version = v_version
       where story_id = v_story;
      -- Retain the identity and its snapshots, and let old detail links resolve forward.
      update theia.threads set merged_into_id = v_target, updated_at = p_now where id = v_current;
      delete from theia.thread_terms where thread_id = v_current;
      insert into theia.story_events (event_type, story_id, thread_id, related_thread_id, occurred_at, cluster_version)
      values ('thread_merge', v_story, v_target, v_current, p_now, v_version);
    end if;

    if (v_item->>'method') <> 'new_thread' then
      insert into theia.story_events (event_type, story_id, thread_id, related_thread_id, occurred_at, cluster_version, detail)
      values ('thread_link', v_story, v_target, v_current, p_now, v_version,
        jsonb_build_object('score', v_item->'score', 'sharedTerms', v_item->'sharedTerms'));
      v_linked := v_linked + 1;
    end if;

    select dormant_at into v_dormant from theia.threads where id = v_target;
    if v_dormant is not null then
      update theia.threads set dormant_at = null, updated_at = p_now where id = v_target;
      insert into theia.story_events (event_type, story_id, thread_id, occurred_at, cluster_version, detail)
      values ('thread_reignite', v_story, v_target, p_now, v_version, jsonb_build_object('dormantSince', v_dormant));
      v_reignited := v_reignited + 1;
    end if;
    v_touched := v_touched || v_target;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload->'threadUpdates', '[]'::jsonb)) loop
    v_target := coalesce(nullif(v_item->>'threadId', '')::uuid, (v_map->>(v_item->>'threadKey'))::uuid);
    continue when v_target is null or not exists (select 1 from theia.threads where id = v_target and merged_into_id is null);
    update theia.threads
       set signature = coalesce(v_item->'signature', signature),
           label = left(coalesce(v_item->>'label', label), 200),
           updated_at = p_now
     where id = v_target;
    delete from theia.thread_terms where thread_id = v_target;
    insert into theia.thread_terms (thread_id, term, weight)
    select v_target, left(kv.key, 200), (kv.value #>> '{}')::numeric
      from jsonb_each(coalesce(v_item->'signature', '{}'::jsonb)) kv
    on conflict do nothing;
    v_touched := v_touched || v_target;
  end loop;

  update theia.thread_stories set evaluated_at = p_now
   where story_id in (select x::uuid from jsonb_array_elements_text(coalesce(p_payload->'evaluated', '[]'::jsonb)) x);

  -- Threads created for stories that turned out to be linked elsewhere are dropped.
  delete from theia.threads t
   where t.id in (select (kv.value #>> '{}')::uuid from jsonb_each(v_map) kv)
     and t.merged_into_id is null
     and not exists (select 1 from theia.thread_stories ts where ts.thread_id = t.id);

  perform theia.sync_thread_aggregates(v_touched, p_now);

  return jsonb_build_object('threadsCreated', v_created, 'linked', v_linked, 'reignited', v_reignited);
end $$;

-- Unknown days stay unknown even when a different source supplied some articles.
create or replace function theia.day_flags(p_country text, p_from date, p_to date, p_cutoff timestamptz)
returns table (day date, known boolean, partial boolean)
language sql stable set search_path = '' as $$
  select g.d,
         c.started_day is not null and g.d >= c.started_day and not theia.day_has_gap(p_country, g.d, p_cutoff),
         g.d = c.started_day or g.d = (p_cutoff at time zone 'UTC')::date
           or theia.day_has_gap(p_country, g.d, p_cutoff)
    from (select gs::date as d from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs) g
   cross join (select (collection_started_at at time zone 'UTC')::date as started_day
                 from theia.countries where code = p_country) c
   order by g.d;
$$;

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
  last3_known int := 0;
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
    roll := array_append(roll, case when p_known[i] and c > 0 then s / c end);
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
        last3_known := last3_known + 1;
      end if;
    end if;
    if roll[i] is not null and roll[i] > peak3 then
      peak3 := roll[i];
      peak3_idx := i;
    end if;
    series := series || jsonb_build_object('day', p_days[i], 'count', case when p_known[i] then p_counts[i] end,
      'known', p_known[i], 'partial', p_known[i] and p_partial[i]);
  end loop;

  if known_days = 0 or last3_known = 0 then
    status := 'unknown';
  elsif p_dormant then
    status := 'dormant';
  elsif last3 > 0 and (select r from unnest(roll) with ordinality as x(r, idx)
                        where idx > n - 3 and r is not null order by idx desc limit 1) >= peak3 / 2 then
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

-- A rolling N-day interval can touch N+1 UTC dates. Interior dates use the
-- precomputed daily table; boundary dates are counted from articles with the exact
-- same exclusive start / inclusive cutoff as rankings. Pre-collection observations
-- are partial lower bounds, but observations inside a recorded gap remain unknown.
create or replace function theia.thread_stats(p_thread uuid, p_country text, p_cutoff timestamptz, p_days int default 30)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_start timestamptz := p_cutoff - make_interval(days => p_days);
  v_from date := (v_start at time zone 'UTC')::date;
  v_to date := (p_cutoff at time zone 'UTC')::date;
  v_days date[];
  v_counts int[];
  v_known boolean[];
  v_partial boolean[];
  v_dormant boolean;
begin
  with boundary as (
    select (a.effective_at at time zone 'UTC')::date as day, count(distinct a.publisher_id)::int as pubs
      from theia.thread_stories ts
      join theia.story_articles sa on sa.story_id = ts.story_id
      join theia.articles a on a.id = sa.article_id
      join theia.publishers p on p.id = a.publisher_id
     where ts.thread_id = p_thread and p.country_code = p_country
       and a.effective_at > v_start and a.effective_at <= p_cutoff
       and ((a.effective_at at time zone 'UTC')::date = v_from or (a.effective_at at time zone 'UTC')::date = v_to)
     group by 1
  ), daily as (
    select f.*, case when f.day in (v_from, v_to) then coalesce(b.pubs, 0)
                    else coalesce(c.distinct_publisher_count, 0) end as pubs
      from theia.day_flags(p_country, v_from, v_to, p_cutoff) f
      left join boundary b on b.day = f.day
      left join theia.thread_daily_coverage c on c.thread_id = p_thread and c.country_code = p_country and c.day = f.day
  )
  select array_agg(d.day order by d.day), array_agg(d.pubs order by d.day),
         array_agg((d.known or d.pubs > 0) and not theia.day_has_gap(p_country, d.day, p_cutoff) order by d.day),
         array_agg(coalesce(d.partial, false) or not d.known or d.day = v_from order by d.day)
    into v_days, v_counts, v_known, v_partial from daily d;
  select t.dormant_at is not null into v_dormant from theia.threads t where t.id = p_thread;
  return theia.series_stats(v_days, v_counts, v_known, v_partial, coalesce(v_dormant, false));
end $$;

create or replace function theia.story_stats(p_story uuid, p_country text, p_cutoff timestamptz, p_days int default 30)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_start timestamptz := p_cutoff - make_interval(days => p_days);
  v_from date := (v_start at time zone 'UTC')::date;
  v_to date := (p_cutoff at time zone 'UTC')::date;
  v_days date[];
  v_counts int[];
  v_known boolean[];
  v_partial boolean[];
begin
  select array_agg(f.day order by f.day), array_agg(coalesce(c.pubs, 0) order by f.day),
         array_agg((f.known or coalesce(c.pubs, 0) > 0) and not theia.day_has_gap(p_country, f.day, p_cutoff) order by f.day),
         array_agg(coalesce(f.partial, false) or not f.known or f.day = v_from order by f.day)
    into v_days, v_counts, v_known, v_partial
    from theia.day_flags(p_country, v_from, v_to, p_cutoff) f
    left join (
      select (a.effective_at at time zone 'UTC')::date as day, count(distinct a.publisher_id)::int as pubs
        from theia.story_articles sa join theia.articles a on a.id = sa.article_id
        join theia.publishers p on p.id = a.publisher_id
       where sa.story_id = p_story and p.country_code = p_country
         and a.effective_at > v_start and a.effective_at <= p_cutoff
       group by 1
    ) c on c.day = f.day;
  return theia.series_stats(v_days, v_counts, v_known, v_partial, false);
end $$;

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
       and not theia.day_has_gap(p_country, (a.effective_at at time zone 'UTC')::date, p_cutoff)
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

  -- Hold the lock while checking the latest accepted cutoff. An equal or older
  -- refresh must not replace daily coverage or create reconstructed past snapshots.
  if exists (select 1 from theia.cached_views v
              where v.country_code = p_country and v.observation_cutoff >= p_cutoff) then
    return jsonb_build_object('country', p_country, 'skipped', true, 'viewsWritten', 0,
      'reason', 'cutoff already refreshed');
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

create or replace function public.theia_get_thread(p_thread uuid, p_country text, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_thread theia.threads%rowtype;
begin
  p_thread := theia.resolve_thread(p_thread);
  select * into v_thread from theia.threads where id = p_thread;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_thread.id,
    'unit', 'thread',
    'country', p_country,
    'language', v_thread.language_code,
    'category', v_thread.category,
    'label', v_thread.label,
    'signatureTerms', (
      select coalesce(jsonb_agg(kv.key order by (kv.value #>> '{}')::numeric desc, kv.key), '[]'::jsonb)
        from jsonb_each(v_thread.signature) kv),
    'firstSeenAt', v_thread.first_seen_at,
    'lastSeenAt', v_thread.last_seen_at,
    'dormantAt', v_thread.dormant_at,
    'storyCount', (select count(*) from theia.thread_stories ts where ts.thread_id = p_thread),
    'stats', theia.thread_stats(p_thread, p_country, p_now),
    'byCountry', (
      select coalesce(jsonb_agg(jsonb_build_object('country', q.country_code, 'publisherDays', q.pd, 'activeDays', q.ad)
               order by q.pd desc, q.country_code), '[]'::jsonb)
        from (
          select c.code as country_code, (s.stats->>'publisherDays')::int as pd, (s.stats->>'activeDays')::int as ad
            from theia.countries c
           cross join lateral (select theia.thread_stats(p_thread, c.code, p_now) as stats) s
           where (s.stats->>'publisherDays')::int > 0
        ) q),
    'stories', (
      select coalesce(jsonb_agg(r.obj order by r.first_seen_at desc, r.id), '[]'::jsonb)
        from (
          select s.id, s.first_seen_at, jsonb_build_object(
              'id', s.id,
              'headline', coalesce(
                (select a.headline_original
                   from theia.story_articles sa
                   join theia.articles a on a.id = sa.article_id
                   join theia.publishers p on p.id = a.publisher_id
                  where sa.story_id = s.id
                  order by (p.country_code = p_country) desc, a.effective_at, a.id
                  limit 1), ''),
              'category', s.category,
              'firstSeenAt', s.first_seen_at,
              'lastSeenAt', s.last_seen_at,
              'publisherCount', (
                select count(distinct a.publisher_id)
                  from theia.story_articles sa
                  join theia.articles a on a.id = sa.article_id
                  join theia.publishers p on p.id = a.publisher_id
                 where sa.story_id = s.id and p.country_code = p_country),
              'articleCount', (select count(*) from theia.story_articles sa where sa.story_id = s.id)) as obj
            from theia.thread_stories ts
            join theia.stories s on s.id = ts.story_id
           where ts.thread_id = p_thread
           order by s.first_seen_at desc, s.id
           limit 60
        ) r));
end $$;

create or replace function public.theia_admin_status(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', public.theia_data_status(p_now),
    'heartbeats', (
      select coalesce(jsonb_agg(jsonb_build_object('component', h.component, 'lastBeatAt', h.last_beat_at,
               'ageSeconds', greatest(extract(epoch from (p_now - h.last_beat_at)), 0)::int, 'detail', h.detail)
               order by h.component), '[]'::jsonb)
        from theia.pipeline_heartbeats h),
    'totals', jsonb_build_object(
      'articles', (select count(*) from theia.articles),
      'activePublishers', (select count(*) from theia.publishers where enabled),
      'candidatePublishers', (select count(*) from theia.publishers),
      'stories', (select count(*) from theia.stories),
      'threads', (select count(*) from theia.threads where merged_into_id is null),
      'multiStoryThreads', (
        select count(*) from (select thread_id from theia.thread_stories group by thread_id having count(*) > 1) t),
      'snapshots', (select count(*) from theia.story_metric_snapshots) + (select count(*) from theia.thread_metric_snapshots),
      'databaseBytes', pg_database_size(current_database()),
      'theiaBytes', (
        select coalesce(sum(pg_total_relation_size(c.oid)), 0)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'theia' and c.relkind = 'r')),
    'settings', (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) from theia.pipeline_settings s),
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'sourceKey', s.source_key, 'publisher', p.name, 'country', p.country_code, 'section', f.section_label,
          'state', s.state, 'lastSuccessAt', s.last_success_at, 'lastNewArticleAt', s.last_new_article_at,
          'lastAttemptAt', s.last_attempt_at, 'nextDueAt', s.next_due_at, 'attemptCount', s.attempt_count,
          'lastError', s.last_error, 'leased', s.leased_until is not null and s.leased_until > p_now,
          'overdueSeconds', case when s.next_due_at < p_now
                                 then extract(epoch from (p_now - s.next_due_at))::int else 0 end,
          'withinFreshnessTarget', s.last_success_at is not null
             and s.last_success_at > p_now - make_interval(secs => s.freshness_target_seconds)
        ) order by p.country_code, p.name, f.section_label), '[]'::jsonb)
        from theia.source_schedules s
        join theia.publisher_feeds f on f.id = s.publisher_feed_id
        join theia.publishers p on p.id = f.publisher_id
       where s.state <> 'disabled'),
    'recentRuns', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'sourceKey', r.source_key, 'status', r.status, 'startedAt', r.started_at, 'finishedAt', r.finished_at,
          'durationMs', (extract(epoch from (r.finished_at - r.started_at)) * 1000)::int,
          'httpStatus', r.http_status, 'fetched', r.records_fetched, 'inserted', r.records_inserted,
          'rejected', r.records_rejected, 'error', r.error_summary
        ) order by r.started_at desc), '[]'::jsonb)
        from (select * from theia.ingestion_runs order by started_at desc limit 40) r),
    'gaps', (
      select coalesce(jsonb_agg(jsonb_build_object('sourceKey', g.source_key, 'country', g.country_code,
               'start', g.gap_start, 'end', g.gap_end, 'reason', g.reason) order by g.recorded_at desc), '[]'::jsonb)
        from (select * from theia.coverage_gaps order by recorded_at desc limit 20) g));
$$;

-- Helpers stay private; public RPCs retain service-role-only execution.
revoke all on function theia.resolve_thread(uuid) from public;
revoke all on function theia.day_has_gap(text, date, timestamptz) from public;
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

