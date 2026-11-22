-- Project Theia: origins and attention signals.
--
-- An origin is any place an entry can come from: the monitored press, a search-trend
-- feed, a social platform, a reference site, a community or an aggregator. Every entry
-- the API returns names its origin, and each origin carries the attributes that control
-- how its entries are shown and weighted (kind, lane, weight, display order, visibility).
--
-- Signals are entries from non-press origins: a trending search, a platform trend, a
-- most-read article, a front-page link. They are stored as items plus one row per item,
-- source and UTC day, so storage grows with distinct items, not with poll frequency.

create table theia.origins (
  key text primary key,
  name text not null,
  kind text not null check (kind in ('press', 'search', 'social', 'reference', 'community', 'aggregator')),
  lane text not null default 'attention' check (lane in ('press', 'attention')),
  weight numeric not null default 1 check (weight >= 0),
  display_order int not null default 100,
  visible boolean not null default true,
  enabled boolean not null default false,
  attribution text,
  terms_url text,
  tags text[] not null default '{}',
  updated_at timestamptz not null default now()
);

insert into theia.origins (key, name, kind, lane, weight, display_order, visible, enabled, attribution)
values ('press', 'Monitored press', 'press', 'press', 1, 0, true, true, 'Publisher RSS feeds');

-- The same handles for individual publishers. Not used in ranking yet.
alter table theia.publishers
  add column weight numeric not null default 1 check (weight >= 0),
  add column tags text[] not null default '{}';

create table theia.signal_schedules (
  source_key text primary key,
  origin_key text not null references theia.origins (key),
  scope_key text not null,
  country_code text references theia.countries (code),
  language_code text,
  -- Countries whose views include this source. A global or language-wide source lists several.
  view_countries text[] not null default '{}',
  params jsonb not null default '{}'::jsonb,
  cadence_seconds int not null default 10800 check (cadence_seconds >= 300),
  next_due_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  attempt_count int not null default 0,
  retry_after timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb,
  state text not null default 'ok' check (state in ('ok', 'retrying', 'needs_attention', 'disabled')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index signal_schedules_due_idx on theia.signal_schedules (next_due_at) where state <> 'disabled';

create table theia.signal_items (
  id uuid primary key default gen_random_uuid(),
  origin_key text not null references theia.origins (key),
  item_key text not null,
  -- Title and link as first seen. The same item can be listed by several sources (a trend
  -- in two countries), each with its own wording and links, so what a source said about
  -- it is stored on that source's daily row, not here.
  title text not null,
  url text,
  language_code text,
  entity_id text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (origin_key, item_key)
);
create index signal_items_entity_idx on theia.signal_items (entity_id) where entity_id is not null;

create table theia.signal_daily (
  signal_item_id uuid not null references theia.signal_items (id) on delete cascade,
  source_key text not null references theia.signal_schedules (source_key) on delete cascade,
  origin_key text not null,
  day date not null,
  best_rank int not null,
  last_rank int not null,
  observations int not null default 1,
  metric_kind text,
  metric_value numeric,
  -- This source's latest reading of the item that day.
  title text,
  url text,
  summary text,
  related jsonb not null default '[]'::jsonb,
  -- Normalized article URLs the reading points at; used to find the matching press story.
  related_urls text[] not null default '{}',
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  primary key (signal_item_id, source_key, day)
);
create index signal_daily_source_idx on theia.signal_daily (source_key, last_observed_at desc);

alter table theia.origins enable row level security;
alter table theia.signal_schedules enable row level security;
alter table theia.signal_items enable row level security;
alter table theia.signal_daily enable row level security;

-- Upserts origins and their schedules from config/signal-sources.json. Nothing is deleted:
-- a source that leaves the file is disabled and keeps its history. The press origin's
-- display attributes can be set here too.
create or replace function public.theia_sync_origins(p_config jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin jsonb;
  v_scope jsonb;
  v_key text;
  v_enabled boolean;
  v_source text;
  v_keys text[] := '{}';
  v_origins int := 0;
  v_schedules int := 0;
  v_active int := 0;
begin
  for v_origin in select * from jsonb_array_elements(coalesce(p_config->'origins', '[]'::jsonb)) loop
    v_key := v_origin->>'key';
    v_enabled := coalesce((v_origin->>'enabled')::boolean, false);
    insert into theia.origins as o (key, name, kind, lane, weight, display_order, visible, enabled, attribution, terms_url, tags, updated_at)
    values (
      v_key, v_origin->>'name', v_origin->>'kind', coalesce(v_origin->>'lane', 'attention'),
      coalesce((v_origin->>'weight')::numeric, 1), coalesce((v_origin->>'displayOrder')::int, 100),
      coalesce((v_origin->>'visible')::boolean, true), v_enabled or v_key = 'press',
      v_origin->>'attribution', v_origin->>'termsUrl',
      coalesce((select array_agg(x) from jsonb_array_elements_text(v_origin->'tags') x), '{}'), p_now)
    on conflict (key) do update set
      name = excluded.name, kind = excluded.kind, lane = excluded.lane, weight = excluded.weight,
      display_order = excluded.display_order, visible = excluded.visible, enabled = excluded.enabled,
      attribution = excluded.attribution, terms_url = excluded.terms_url, tags = excluded.tags,
      updated_at = excluded.updated_at;
    v_origins := v_origins + 1;

    for v_scope in select * from jsonb_array_elements(coalesce(v_origin->'scopes', '[]'::jsonb)) loop
      v_source := v_key || ':' || (v_scope->>'scope');
      insert into theia.signal_schedules as s (source_key, origin_key, scope_key, country_code, language_code,
        view_countries, params, cadence_seconds, next_due_at, state, updated_at)
      values (
        v_source, v_key, v_scope->>'scope', v_scope->>'country', v_scope->>'language',
        coalesce((select array_agg(x) from jsonb_array_elements_text(v_scope->'viewCountries') x), '{}'),
        coalesce(v_scope->'params', '{}'::jsonb),
        coalesce((v_scope->>'cadenceSeconds')::int, (v_origin->>'cadenceSeconds')::int, 10800),
        p_now, case when v_enabled then 'ok' else 'disabled' end, p_now)
      on conflict (source_key) do update set
        country_code = excluded.country_code, language_code = excluded.language_code,
        view_countries = excluded.view_countries, params = excluded.params,
        cadence_seconds = excluded.cadence_seconds,
        state = case when not v_enabled then 'disabled' when s.state = 'disabled' then 'ok' else s.state end,
        -- Disabling ends any poll in flight: its lease is void, so its commit changes nothing.
        lease_token = case when v_enabled then s.lease_token else null end,
        leased_until = case when v_enabled then s.leased_until else null end,
        next_due_at = case when v_enabled and s.state = 'disabled' then p_now else s.next_due_at end,
        attempt_count = case when v_enabled and s.state = 'disabled' then 0 else s.attempt_count end,
        updated_at = p_now;
      v_keys := v_keys || v_source;
      v_schedules := v_schedules + 1;
      if v_enabled then v_active := v_active + 1; end if;
    end loop;
  end loop;

  update theia.signal_schedules set state = 'disabled', lease_token = null, leased_until = null, updated_at = p_now
   where not (source_key = any (v_keys)) and (state <> 'disabled' or lease_token is not null);

  return jsonb_build_object('origins', v_origins, 'schedules', v_schedules, 'activeSchedules', v_active);
end $$;

-- Sets the weight and tags of publishers by slug: {"nyt": {"weight": 1, "tags": ["national"]}}.
create or replace function public.theia_set_publisher_attributes(p_attributes jsonb, p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  update theia.publishers p
     set weight = coalesce((a.value->>'weight')::numeric, p.weight),
         tags = case when a.value ? 'tags'
                     then coalesce((select array_agg(x) from jsonb_array_elements_text(a.value->'tags') x), '{}')
                     else p.tags end,
         updated_at = p_now
    from jsonb_each(coalesce(p_attributes, '{}'::jsonb)) a
   where p.slug = a.key;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- How many signal sources are due. Origins the worker has no credentials for are left out,
-- so a missing key never wakes the worker or counts as a failure.
create or replace function public.theia_signals_due(p_exclude_origins jsonb default '[]'::jsonb, p_now timestamptz default now())
returns int language sql stable security definer set search_path = '' as $$
  select case when theia.setting_bool('dispatch_paused', false) then 0 else (
    select count(*)::int
      from theia.signal_schedules s
      join theia.origins o on o.key = s.origin_key
     where s.state <> 'disabled' and o.enabled
       and s.origin_key not in (select jsonb_array_elements_text(coalesce(p_exclude_origins, '[]'::jsonb)))
       and s.next_due_at <= p_now and (s.leased_until is null or s.leased_until < p_now)) end;
$$;

-- Claims due signal sources under a lease. A source may name a seed source in its params
-- (seedSource, seedLimit): the claim then carries that source's current top titles.
create or replace function public.theia_claim_due_signals(
  p_limit int default 10, p_lease_seconds int default 300, p_exclude_origins jsonb default '[]'::jsonb,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  with due as (
    select s.source_key
      from theia.signal_schedules s
      join theia.origins o on o.key = s.origin_key
     where s.state <> 'disabled' and o.enabled
       and s.origin_key not in (select jsonb_array_elements_text(coalesce(p_exclude_origins, '[]'::jsonb)))
       and s.next_due_at <= p_now and (s.leased_until is null or s.leased_until < p_now)
     order by s.next_due_at, s.source_key
     limit greatest(p_limit, 0)
       for update of s skip locked
  ), claimed as (
    update theia.signal_schedules s
       set lease_token = gen_random_uuid(),
           leased_until = p_now + make_interval(secs => p_lease_seconds),
           last_attempt_at = p_now,
           updated_at = p_now
      from due
     where s.source_key = due.source_key
    returning s.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sourceKey', c.source_key,
      'leaseToken', c.lease_token,
      'originKey', c.origin_key,
      'scopeKey', c.scope_key,
      'country', c.country_code,
      'language', c.language_code,
      'params', c.params,
      'checkpoint', c.checkpoint,
      'cadenceSeconds', c.cadence_seconds,
      'lastSuccessAt', c.last_success_at,
      'seeds', (
        select coalesce(jsonb_agg(q.title order by q.last_rank, q.title), '[]'::jsonb)
          from (
            select i.title, d.last_rank
              from theia.signal_daily d
              join theia.signal_items i on i.id = d.signal_item_id
             where c.params ? 'seedSource' and d.source_key = c.params->>'seedSource'
               and d.last_observed_at = (
                 select max(d2.last_observed_at) from theia.signal_daily d2 where d2.source_key = c.params->>'seedSource')
             order by d.last_rank, i.title
             limit coalesce((c.params->>'seedLimit')::int, 3)
          ) q)
    ) order by c.source_key), '[]'::jsonb)
    into v_result
    from claimed c;
  return v_result;
end $$;

-- Commits one signal poll. Unlike press articles, which are only ever inserted, a signal
-- reading replaces the previous one, so nothing is written unless the caller still holds
-- the lease on a source that is still enabled. A worker that finishes late, or a source
-- switched off mid-poll, changes nothing. Readings are timed from when the poll started,
-- and a reading never replaces a newer one.
create or replace function public.theia_commit_signal_poll(
  p_source_key text, p_lease_token uuid, p_result jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sched theia.signal_schedules%rowtype;
  v_status text := coalesce(p_result->>'status', 'success');
  v_started timestamptz := coalesce(nullif(p_result->>'startedAt', '')::timestamptz, p_now);
  v_observed timestamptz := least(v_started, p_now);
  v_day date := coalesce(nullif(p_result->>'day', '')::date, (v_observed at time zone 'UTC')::date);
  v_fetched int := jsonb_array_length(coalesce(p_result->'items', '[]'::jsonb));
  v_items int := 0;
  v_new int := 0;
  v_lease_valid boolean;
begin
  if v_status not in ('success', 'unchanged') then
    raise exception 'commit status must be success or unchanged, got %', v_status;
  end if;
  select * into v_sched from theia.signal_schedules where source_key = p_source_key for update;
  if not found then
    raise exception 'unknown signal source %', p_source_key;
  end if;

  v_lease_valid := p_lease_token is not null and v_sched.lease_token is not distinct from p_lease_token
    and v_sched.state <> 'disabled';

  if v_lease_valid then
    with incoming as (
      select distinct on (x.item_key) x.*
        from jsonb_to_recordset(coalesce(p_result->'items', '[]'::jsonb)) as x(
          item_key text, title text, url text, language_code text, summary text, entity_id text,
          related jsonb, related_urls jsonb, rank int, metric_kind text, metric_value numeric)
       where x.item_key is not null and length(trim(coalesce(x.title, ''))) > 0 and x.rank is not null
       order by x.item_key, x.rank
    ), up as (
      insert into theia.signal_items as i (origin_key, item_key, title, url, language_code, entity_id, first_seen_at, last_seen_at)
      select v_sched.origin_key, left(n.item_key, 500), left(n.title, 500), left(n.url, 2000),
             coalesce(n.language_code, v_sched.language_code), left(n.entity_id, 40), v_observed, v_observed
        from incoming n
      on conflict (origin_key, item_key) do update set
        entity_id = coalesce(i.entity_id, excluded.entity_id),
        last_seen_at = greatest(i.last_seen_at, excluded.last_seen_at)
      returning i.id, i.item_key, (xmax = 0) as inserted
    ), daily as (
      insert into theia.signal_daily as d (signal_item_id, source_key, origin_key, day, best_rank, last_rank,
        observations, metric_kind, metric_value, title, url, summary, related, related_urls, first_observed_at, last_observed_at)
      select up.id, p_source_key, v_sched.origin_key, v_day, n.rank, n.rank, 1, n.metric_kind, n.metric_value,
             left(n.title, 500), left(n.url, 2000), nullif(left(n.summary, 500), ''),
             case when n.related is null or octet_length(n.related::text) > 4096 then '[]'::jsonb else n.related end,
             coalesce((select array_agg(u) from jsonb_array_elements_text(n.related_urls) u), '{}'),
             v_observed, v_observed
        from up join incoming n on left(n.item_key, 500) = up.item_key
      on conflict (signal_item_id, source_key, day) do update set
        best_rank = least(d.best_rank, excluded.best_rank),
        observations = d.observations + case when excluded.last_observed_at > d.last_observed_at then 1 else 0 end,
        last_rank = case when excluded.last_observed_at >= d.last_observed_at then excluded.last_rank else d.last_rank end,
        metric_kind = case when excluded.last_observed_at >= d.last_observed_at then coalesce(excluded.metric_kind, d.metric_kind) else d.metric_kind end,
        metric_value = case when excluded.last_observed_at >= d.last_observed_at then coalesce(excluded.metric_value, d.metric_value) else d.metric_value end,
        title = case when excluded.last_observed_at >= d.last_observed_at then excluded.title else d.title end,
        url = case when excluded.last_observed_at >= d.last_observed_at then coalesce(excluded.url, d.url) else d.url end,
        summary = case when excluded.last_observed_at >= d.last_observed_at then coalesce(excluded.summary, d.summary) else d.summary end,
        related = case when excluded.last_observed_at >= d.last_observed_at and excluded.related <> '[]'::jsonb then excluded.related else d.related end,
        related_urls = case when excluded.last_observed_at >= d.last_observed_at and excluded.related_urls <> '{}' then excluded.related_urls else d.related_urls end,
        first_observed_at = least(d.first_observed_at, excluded.first_observed_at),
        last_observed_at = greatest(d.last_observed_at, excluded.last_observed_at)
      returning 1
    )
    select (select count(*) from daily), (select count(*) from up where inserted) into v_items, v_new;
  end if;

  insert into theia.ingestion_runs (source_key, provider, country_code, started_at, finished_at, status, http_status,
    records_fetched, records_inserted, records_rejected, checkpoint_after, metadata)
  values (p_source_key, v_sched.origin_key, v_sched.country_code, v_started, p_now, v_status,
    (p_result->>'httpStatus')::int, v_fetched, v_new, greatest(v_fetched - v_items, 0),
    p_result->'checkpoint', jsonb_build_object('leaseValid', v_lease_valid, 'day', v_day, 'signal', true));

  if v_lease_valid then
    update theia.signal_schedules
       set checkpoint = coalesce(p_result->'checkpoint', checkpoint),
           last_success_at = p_now, attempt_count = 0, retry_after = null, state = 'ok', last_error = null,
           lease_token = null, leased_until = null,
           next_due_at = p_now + make_interval(secs => cadence_seconds),
           updated_at = p_now
     where source_key = p_source_key;
  end if;

  return jsonb_build_object('items', v_items, 'newItems', v_new, 'leaseValid', v_lease_valid, 'day', v_day);
end $$;

-- Records a failed signal poll. Same policy as press feeds: exponential backoff with
-- jitter, capped at the cadence, never earlier than Retry-After.
create or replace function public.theia_fail_signal_poll(
  p_source_key text, p_lease_token uuid, p_error jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sched theia.signal_schedules%rowtype;
  v_max int := theia.setting_num('max_poll_attempts', 5)::int;
  v_attempts int;
  v_backoff numeric;
  v_next timestamptz;
  v_retry_after timestamptz;
  v_state text;
  v_lease_valid boolean;
  v_started timestamptz := coalesce(nullif(p_error->>'startedAt', '')::timestamptz, p_now);
  v_jitter numeric := coalesce((p_error->>'jitter')::numeric, random());
begin
  select * into v_sched from theia.signal_schedules where source_key = p_source_key for update;
  if not found then
    raise exception 'unknown signal source %', p_source_key;
  end if;
  v_lease_valid := p_lease_token is not null and v_sched.lease_token is not distinct from p_lease_token
    and v_sched.state <> 'disabled';

  insert into theia.ingestion_runs (source_key, provider, country_code, started_at, finished_at, status, http_status,
    error_summary, metadata)
  values (p_source_key, v_sched.origin_key, v_sched.country_code, v_started, p_now, 'failed', (p_error->>'httpStatus')::int,
    left(coalesce(p_error->>'message', 'unknown error'), 500), jsonb_build_object('leaseValid', v_lease_valid, 'signal', true));

  if not v_lease_valid then
    return jsonb_build_object('leaseValid', false);
  end if;

  v_attempts := v_sched.attempt_count + 1;
  if (p_error->>'retryAfterSeconds') is not null then
    v_retry_after := p_now + make_interval(secs => greatest((p_error->>'retryAfterSeconds')::numeric, 0)::int);
  end if;
  if v_attempts >= v_max then
    v_state := 'needs_attention';
    v_next := p_now + make_interval(secs => v_sched.cadence_seconds);
  else
    v_state := 'retrying';
    v_backoff := least(v_sched.cadence_seconds, 300 * power(2, v_attempts - 1)) * (0.75 + 0.5 * v_jitter);
    v_next := p_now + make_interval(secs => least(v_backoff, v_sched.cadence_seconds)::int);
  end if;
  if v_retry_after is not null and v_retry_after > v_next then
    v_next := v_retry_after;
  end if;

  update theia.signal_schedules
     set attempt_count = v_attempts, retry_after = v_retry_after, state = v_state,
         last_error = left(coalesce(p_error->>'message', 'unknown error'), 500),
         lease_token = null, leased_until = null, next_due_at = v_next, updated_at = p_now
   where source_key = p_source_key;

  return jsonb_build_object('leaseValid', true, 'attemptCount', v_attempts, 'state', v_state, 'nextDueAt', v_next);
end $$;

-- Rank points for one day: rank 1 scores 1.0, rank 50 and beyond score 0.02.
create or replace function theia.rank_points(p_rank int)
returns numeric language sql immutable set search_path = '' as $$
  select (51 - least(greatest(p_rank, 1), 50))::numeric / 50;
$$;

-- Every origin with its display attributes and current health.
create or replace function theia.origins_block(p_country text, p_now timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', o.key, 'name', o.name, 'kind', o.kind, 'lane', o.lane, 'weight', o.weight,
      'displayOrder', o.display_order, 'visible', o.visible, 'enabled', o.enabled,
      'attribution', o.attribution, 'termsUrl', o.terms_url, 'tags', to_jsonb(o.tags),
      'sources', coalesce(s.sources, '[]'::jsonb),
      'lastSuccessAt', s.last_success_at
    ) order by o.display_order, o.key), '[]'::jsonb)
    from theia.origins o
    left join lateral (
      select max(x.last_success_at) as last_success_at,
             jsonb_agg(jsonb_build_object('sourceKey', x.source_key, 'scope', x.scope_key, 'state', x.state,
               'lastSuccessAt', x.last_success_at, 'lastError', x.last_error) order by x.source_key) as sources
        from theia.signal_schedules x
       where x.origin_key = o.key and (p_country is null or p_country = any (x.view_countries))
    ) s on true;
$$;

-- The attention view for one country and window: entries from every non-press origin
-- whose sources feed this country, each tagged with its origin, scored, and linked to a
-- press story when one of its article URLs was also collected from a monitored publisher.
-- Title, link and attached articles come from this country's own reading of the entry.
--
-- Score = origin weight x rank points. For 24h the best day in the window counts; for
-- longer windows the days add up, so an entry that stays on a list outranks a one-day spike.
create or replace function public.theia_get_signals(
  p_country text, p_window text default '24h', p_per_origin int default 30, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_span interval := case p_window when '7d' then interval '7 days' when '30d' then interval '30 days' else interval '24 hours' end;
  v_start timestamptz := p_now - v_span;
  v_items jsonb;
begin
  if not exists (select 1 from theia.countries where code = p_country) then
    raise exception 'unknown country %', p_country;
  end if;

  with rows as (
    select d.*, s.scope_key, (s.country_code is not distinct from p_country) as is_local
      from theia.signal_daily d
      join theia.signal_schedules s on s.source_key = d.source_key
      join theia.origins o on o.key = d.origin_key
     where p_country = any (s.view_countries) and o.lane = 'attention'
       and d.last_observed_at > v_start and d.last_observed_at <= p_now
  ), shown as (
    -- One reading describes the entry: this country's own source before a wider one, then the latest.
    select distinct on (r.signal_item_id, r.origin_key)
           r.signal_item_id, r.origin_key, r.scope_key, r.last_rank, r.metric_kind, r.metric_value,
           r.title, r.url, r.summary, r.related, r.related_urls
      from rows r
     order by r.signal_item_id, r.origin_key, r.is_local desc, r.last_observed_at desc, r.last_rank, r.source_key
  ), agg as (
    select r.signal_item_id, r.origin_key,
           min(r.best_rank) as best_rank,
           count(distinct r.day)::int as days_seen,
           min(r.first_observed_at) as first_at, max(r.last_observed_at) as last_at,
           case when p_window = '24h' then max(theia.rank_points(r.best_rank))
                else (select sum(p.pts) from (
                        select max(theia.rank_points(r2.best_rank)) as pts
                          from rows r2
                         where r2.signal_item_id = r.signal_item_id and r2.origin_key = r.origin_key
                         group by r2.day) p) end as points
      from rows r
     group by r.signal_item_id, r.origin_key
  ), scored as (
    select a.*, sh.scope_key, sh.last_rank, sh.metric_kind, sh.metric_value, sh.title, sh.url, sh.summary,
           sh.related, sh.related_urls, o.kind, round(o.weight * a.points, 4) as score,
           row_number() over (partition by a.origin_key order by o.weight * a.points desc, sh.last_rank, a.signal_item_id) as origin_rank
      from agg a
      join shown sh on sh.signal_item_id = a.signal_item_id and sh.origin_key = a.origin_key
      join theia.origins o on o.key = a.origin_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'origin', sc.origin_key, 'originKind', sc.kind, 'scope', sc.scope_key,
      'title', coalesce(sc.title, i.title), 'url', coalesce(sc.url, i.url), 'language', i.language_code,
      'summary', sc.summary, 'entityId', i.entity_id, 'related', sc.related,
      'rank', sc.last_rank, 'bestRank', sc.best_rank, 'originRank', sc.origin_rank, 'daysSeen', sc.days_seen,
      'metricKind', sc.metric_kind, 'metricValue', sc.metric_value, 'score', sc.score,
      'firstSeenAt', sc.first_at, 'lastSeenAt', sc.last_at,
      'storyId', m.story_id, 'threadId', m.thread_id
    ) order by sc.score desc, sc.last_rank, i.id), '[]'::jsonb)
    into v_items
    from scored sc
    join theia.signal_items i on i.id = sc.signal_item_id
    left join lateral (
      select sa.story_id, ts.thread_id
        from theia.articles a
        join theia.story_articles sa on sa.article_id = a.id
        left join theia.thread_stories ts on ts.story_id = sa.story_id
       where a.normalized_url = any (sc.related_urls)
       order by a.effective_at
       limit 1
    ) m on true
   where sc.origin_rank <= greatest(p_per_origin, 1);

  return jsonb_build_object(
    'schemaVersion', 1, 'country', p_country, 'window', p_window,
    'windowStart', v_start, 'observationCutoff', p_now,
    'origins', theia.origins_block(p_country, p_now),
    'items', v_items);
end $$;

-- Health of every signal source, for the status command and the admin page.
create or replace function public.theia_signal_status(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'origins', theia.origins_block(null, p_now),
    'items', (select count(*) from theia.signal_items),
    'dailyRows', (select count(*) from theia.signal_daily),
    'needsAttention', (
      select coalesce(jsonb_agg(s.source_key order by s.source_key), '[]'::jsonb)
        from theia.signal_schedules s where s.state = 'needs_attention'));
$$;

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
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'theia' and p.proname in ('rank_points', 'origins_block')
  loop
    execute format('revoke all on function %s from public', r.sig);
  end loop;
end $$;
