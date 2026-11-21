-- Project Theia: registry sync, lease-based polling, clustering and threading writes.
-- Every multi-step write is one function call, so each is one transaction.

create or replace function public.theia_heartbeat(p_component text, p_detail jsonb default '{}'::jsonb, p_now timestamptz default now())
returns void language sql security definer set search_path = '' as $$
  insert into theia.pipeline_heartbeats (component, last_beat_at, detail)
  values (p_component, p_now, coalesce(p_detail, '{}'::jsonb))
  on conflict (component) do update set last_beat_at = excluded.last_beat_at, detail = excluded.detail;
$$;

create or replace function public.theia_set_setting(p_key text, p_value jsonb, p_now timestamptz default now())
returns void language sql security definer set search_path = '' as $$
  insert into theia.pipeline_settings (key, value, updated_at) values (p_key, p_value, p_now)
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
$$;

-- Upserts publishers, feeds and schedules from the registry file. Nothing is ever
-- deleted: a source that leaves the registry is disabled so its history stays intact.
create or replace function public.theia_sync_registry(p_registry jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ds uuid;
  v_pub jsonb;
  v_feed jsonb;
  v_pub_id uuid;
  v_feed_id uuid;
  v_pub_enabled boolean;
  v_active boolean;
  v_keys text[] := '{}';
  v_slugs text[] := '{}';
  v_pubs int := 0;
  v_feeds int := 0;
  v_active_feeds int := 0;
begin
  insert into theia.data_sources as d (provider, name, license_notes)
  values ('rss', coalesce(p_registry->'dataSource'->>'name', 'Curated RSS registry'), p_registry->'dataSource'->>'licenseNotes')
  on conflict (name) do update set license_notes = excluded.license_notes
  returning d.id into v_ds;

  for v_pub in select * from jsonb_array_elements(coalesce(p_registry->'publishers', '[]'::jsonb)) loop
    v_pub_enabled := coalesce((v_pub->>'enabled')::boolean, false);
    insert into theia.publishers as p (slug, name, domain, country_code, country_attribution_method, languages,
      is_wire, terms_status, terms_url, enabled, updated_at)
    values (
      v_pub->>'slug', v_pub->>'name', v_pub->>'domain', v_pub->>'country', v_pub->>'attributionMethod',
      coalesce((select array_agg(x) from jsonb_array_elements_text(v_pub->'languages') x), '{}'),
      coalesce((v_pub->>'isWire')::boolean, false), v_pub->>'termsStatus', v_pub->>'termsUrl', v_pub_enabled, p_now)
    on conflict (slug) do update set
      name = excluded.name, domain = excluded.domain, country_code = excluded.country_code,
      country_attribution_method = excluded.country_attribution_method, languages = excluded.languages,
      is_wire = excluded.is_wire, terms_status = excluded.terms_status, terms_url = excluded.terms_url,
      enabled = excluded.enabled, updated_at = excluded.updated_at
    returning p.id into v_pub_id;
    v_pubs := v_pubs + 1;
    v_slugs := v_slugs || (v_pub->>'slug');

    for v_feed in select * from jsonb_array_elements(coalesce(v_pub->'feeds', '[]'::jsonb)) loop
      v_active := v_pub_enabled and coalesce((v_feed->>'enabled')::boolean, true);
      insert into theia.publisher_feeds as f (publisher_id, data_source_id, feed_url, language_code, section_label,
        default_category, enabled, updated_at)
      values (v_pub_id, v_ds, v_feed->>'url', v_feed->>'language', v_feed->>'section', v_feed->>'defaultCategory', v_active, p_now)
      on conflict (feed_url) do update set
        publisher_id = excluded.publisher_id, language_code = excluded.language_code,
        section_label = excluded.section_label, default_category = excluded.default_category,
        enabled = excluded.enabled, updated_at = excluded.updated_at
      returning f.id into v_feed_id;

      insert into theia.source_schedules as s (source_key, publisher_feed_id, data_source_id, cadence_seconds, next_due_at, state, updated_at)
      values (v_feed->>'sourceKey', v_feed_id, v_ds, coalesce((v_feed->>'cadenceSeconds')::int, 10800), p_now,
        case when v_active then 'ok' else 'disabled' end, p_now)
      on conflict (source_key) do update set
        publisher_feed_id = excluded.publisher_feed_id,
        cadence_seconds = excluded.cadence_seconds,
        state = case when not v_active then 'disabled' when s.state = 'disabled' then 'ok' else s.state end,
        next_due_at = case when v_active and s.state = 'disabled' then p_now else s.next_due_at end,
        attempt_count = case when v_active and s.state = 'disabled' then 0 else s.attempt_count end,
        updated_at = p_now;
      v_keys := v_keys || (v_feed->>'sourceKey');
      v_feeds := v_feeds + 1;
      if v_active then v_active_feeds := v_active_feeds + 1; end if;
    end loop;
  end loop;

  update theia.source_schedules set state = 'disabled', updated_at = p_now
   where not (source_key = any (v_keys)) and state <> 'disabled';
  update theia.publisher_feeds f set enabled = false, updated_at = p_now
   where f.enabled and not exists (
     select 1 from theia.source_schedules s where s.publisher_feed_id = f.id and s.source_key = any (v_keys));
  update theia.publishers set enabled = false, updated_at = p_now
   where enabled and not (slug = any (v_slugs));

  return jsonb_build_object('publishers', v_pubs, 'feeds', v_feeds, 'activeFeeds', v_active_feeds);
end $$;

-- Languages that have recently ingested articles not yet assigned to a story. Normally
-- empty; non-empty after a worker died between committing a poll and clustering.
create or replace function public.theia_pending_languages(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(q.language_code order by q.language_code), '[]'::jsonb)
    from (
      select distinct a.language_code
        from theia.articles a
       where a.ingested_at > p_now - interval '7 days'
         and not exists (select 1 from theia.story_articles sa where sa.article_id = a.id)
    ) q;
$$;

-- A short tick: heartbeat, then report whether there is work.
create or replace function public.theia_dispatch_tick(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_due int;
  v_stale text[];
  v_pending jsonb;
  v_target int := theia.setting_num('view_refresh_target_seconds', 14400)::int;
begin
  if theia.setting_bool('dispatch_paused', false) then
    return jsonb_build_object('paused', true, 'dueSources', 0, 'staleCountries', '[]'::jsonb,
      'pendingLanguages', '[]'::jsonb);
  end if;

  perform public.theia_heartbeat('dispatcher', '{}'::jsonb, p_now);

  select count(*) into v_due
    from theia.source_schedules s
    join theia.publisher_feeds f on f.id = s.publisher_feed_id
    join theia.publishers p on p.id = f.publisher_id
   where s.state <> 'disabled' and f.enabled and p.enabled
     and s.next_due_at <= p_now and (s.leased_until is null or s.leased_until < p_now);

  -- A country needs a refresh when its views are past the refresh target, or when articles
  -- have arrived since they were last computed (a worker died before refreshing).
  select coalesce(array_agg(c.code order by c.sort_order), '{}') into v_stale
    from theia.countries c
   cross join lateral (
     select coalesce(max(v.computed_at), '-infinity'::timestamptz) as computed_at
       from theia.cached_views v where v.country_code = c.code) lv
   where exists (select 1 from theia.publishers p where p.country_code = c.code and p.enabled)
     and (lv.computed_at < p_now - make_interval(secs => v_target)
       or exists (
         select 1 from theia.articles a join theia.publishers p on p.id = a.publisher_id
          where p.country_code = c.code and a.ingested_at > lv.computed_at));

  v_pending := public.theia_pending_languages(p_now);

  return jsonb_build_object('paused', false, 'dueSources', v_due, 'staleCountries', to_jsonb(v_stale),
    'pendingLanguages', v_pending);
end $$;

-- Claims due sources under a lease. SKIP LOCKED makes overlapping workers safe.
create or replace function public.theia_claim_due_sources(
  p_limit int default 10, p_lease_seconds int default 300, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  with due as (
    select s.source_key
      from theia.source_schedules s
      join theia.publisher_feeds f on f.id = s.publisher_feed_id
      join theia.publishers p on p.id = f.publisher_id
     where s.state <> 'disabled' and f.enabled and p.enabled
       and s.next_due_at <= p_now and (s.leased_until is null or s.leased_until < p_now)
     order by s.next_due_at, s.source_key
     limit greatest(p_limit, 0)
       for update of s skip locked
  ), claimed as (
    update theia.source_schedules s
       set lease_token = gen_random_uuid(),
           leased_until = p_now + make_interval(secs => p_lease_seconds),
           last_attempt_at = p_now,
           updated_at = p_now
      from due
     where s.source_key = due.source_key
    returning s.source_key, s.lease_token, s.checkpoint, s.publisher_feed_id, s.cadence_seconds, s.last_success_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sourceKey', c.source_key,
      'leaseToken', c.lease_token,
      'checkpoint', c.checkpoint,
      'cadenceSeconds', c.cadence_seconds,
      'lastSuccessAt', c.last_success_at,
      'feedUrl', f.feed_url,
      'language', f.language_code,
      'section', f.section_label,
      'defaultCategory', f.default_category,
      'publisherId', p.id,
      'publisherSlug', p.slug,
      'publisherName', p.name,
      'domain', p.domain,
      'country', p.country_code
    ) order by c.source_key), '[]'::jsonb)
    into v_result
    from claimed c
    join theia.publisher_feeds f on f.id = c.publisher_feed_id
    join theia.publishers p on p.id = f.publisher_id;
  return v_result;
end $$;

-- Commits one poll. The article upsert is idempotent and always applies; the schedule
-- row changes only when the caller still holds the lease.
create or replace function public.theia_commit_poll(
  p_source_key text, p_lease_token uuid, p_result jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sched theia.source_schedules%rowtype;
  v_feed theia.publisher_feeds%rowtype;
  v_pub theia.publishers%rowtype;
  v_inserted int := 0;
  v_too_old int := 0;
  v_status text := coalesce(p_result->>'status', 'success');
  v_max_age int := theia.setting_num('article_max_age_days', 35)::int;
  v_gap_multiple numeric := theia.setting_num('gap_cadence_multiple', 2);
  v_oldest timestamptz := nullif(p_result->>'feedOldestItemAt', '')::timestamptz;
  v_started timestamptz := coalesce(nullif(p_result->>'startedAt', '')::timestamptz, p_now);
  v_lease_valid boolean;
  v_gap boolean := false;
begin
  if v_status not in ('success', 'unchanged') then
    raise exception 'commit status must be success or unchanged, got %', v_status;
  end if;

  select * into v_sched from theia.source_schedules where source_key = p_source_key for update;
  if not found then
    raise exception 'unknown source %', p_source_key;
  end if;
  select * into v_feed from theia.publisher_feeds where id = v_sched.publisher_feed_id;
  select * into v_pub from theia.publishers where id = v_feed.publisher_id;

  with incoming as (
    select distinct on (x.normalized_url) x.*
      from jsonb_to_recordset(coalesce(p_result->'articles', '[]'::jsonb)) as x(
        normalized_url text, original_url text, headline_original text, headline_normalized text, summary text,
        published_at timestamptz, language_code text, category text, category_method text, category_version int,
        provider_record_id text, source_metadata jsonb)
     where x.normalized_url is not null
       and length(trim(coalesce(x.headline_original, ''))) > 0
     order by x.normalized_url
  ), fresh as (
    select * from incoming
     where published_at is null or published_at > p_now - make_interval(days => v_max_age)
  ), ins as (
    insert into theia.articles (source_provider, provider_record_id, normalized_url, original_url, headline_original,
      headline_normalized, summary, publisher_id, language_code, published_at, first_observed_at, effective_at,
      ingested_at, category, category_method, category_version, source_metadata, created_at, updated_at)
    select 'rss', left(fr.provider_record_id, 500), fr.normalized_url, coalesce(fr.original_url, fr.normalized_url),
      left(fr.headline_original, 500), left(coalesce(fr.headline_normalized, ''), 500),
      nullif(left(fr.summary, 500), ''), v_pub.id, coalesce(fr.language_code, v_feed.language_code),
      fr.published_at, p_now,
      case when fr.published_at is not null and fr.published_at <= p_now then fr.published_at else p_now end,
      p_now,
      case when fr.category in ('politics', 'business', 'technology', 'science', 'health', 'entertainment',
        'sports', 'environment', 'other') then fr.category else 'other' end,
      fr.category_method, fr.category_version,
      case when fr.source_metadata is null or octet_length(fr.source_metadata::text) > 1024
           then '{}'::jsonb else fr.source_metadata end,
      p_now, p_now
      from fresh fr
    on conflict (normalized_url) do nothing
    returning 1
  )
  select (select count(*) from ins), (select count(*) from incoming) - (select count(*) from fresh)
    into v_inserted, v_too_old;

  v_lease_valid := p_lease_token is not null and v_sched.lease_token is not distinct from p_lease_token;

  insert into theia.ingestion_runs (source_key, provider, country_code, started_at, finished_at, status, http_status,
    records_fetched, records_inserted, records_rejected, checkpoint_after, metadata)
  values (p_source_key, 'rss', v_pub.country_code, v_started, p_now, v_status, (p_result->>'httpStatus')::int,
    coalesce((p_result->>'recordsFetched')::int, 0), v_inserted,
    coalesce((p_result->>'recordsRejected')::int, 0) + v_too_old,
    p_result->'checkpoint',
    jsonb_build_object('leaseValid', v_lease_valid, 'tooOld', v_too_old, 'feedUrl', v_feed.feed_url));

  if v_lease_valid then
    -- After real downtime, a feed that no longer reaches back to the last successful
    -- check may have dropped items we never saw. Record that; do not pretend otherwise.
    if v_status = 'success' and v_sched.last_success_at is not null and v_oldest is not null
       and p_now - v_sched.last_success_at > make_interval(secs => (v_sched.cadence_seconds * v_gap_multiple)::int)
       and v_oldest > v_sched.last_success_at then
      insert into theia.coverage_gaps (source_key, country_code, gap_start, gap_end, reason, recorded_at)
      values (p_source_key, v_pub.country_code, v_sched.last_success_at, least(v_oldest, p_now),
        'feed_no_longer_reaches_last_successful_check', p_now);
      v_gap := true;
    end if;

    update theia.source_schedules
       set checkpoint = coalesce(p_result->'checkpoint', checkpoint),
           last_success_at = p_now,
           last_new_article_at = case when v_inserted > 0 then p_now else last_new_article_at end,
           attempt_count = 0,
           retry_after = null,
           state = 'ok',
           last_error = null,
           lease_token = null,
           leased_until = null,
           next_due_at = p_now + make_interval(secs => cadence_seconds),
           updated_at = p_now
     where source_key = p_source_key;

    update theia.countries set collection_started_at = p_now
     where code = v_pub.country_code and collection_started_at is null;
  end if;

  return jsonb_build_object('inserted', v_inserted, 'tooOld', v_too_old, 'leaseValid', v_lease_valid,
    'gapRecorded', v_gap, 'country', v_pub.country_code, 'language', v_feed.language_code);
end $$;

-- Records a failed poll and schedules the retry: exponential backoff with jitter,
-- capped at the source's cadence and never earlier than the publisher's Retry-After.
create or replace function public.theia_fail_poll(
  p_source_key text, p_lease_token uuid, p_error jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sched theia.source_schedules%rowtype;
  v_country text;
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
  select * into v_sched from theia.source_schedules where source_key = p_source_key for update;
  if not found then
    raise exception 'unknown source %', p_source_key;
  end if;
  select p.country_code into v_country
    from theia.publisher_feeds f join theia.publishers p on p.id = f.publisher_id
   where f.id = v_sched.publisher_feed_id;

  v_lease_valid := p_lease_token is not null and v_sched.lease_token is not distinct from p_lease_token;

  insert into theia.ingestion_runs (source_key, provider, country_code, started_at, finished_at, status, http_status,
    error_summary, metadata)
  values (p_source_key, 'rss', v_country, v_started, p_now, 'failed', (p_error->>'httpStatus')::int,
    left(coalesce(p_error->>'message', 'unknown error'), 500), jsonb_build_object('leaseValid', v_lease_valid));

  if not v_lease_valid then
    return jsonb_build_object('leaseValid', false);
  end if;

  v_attempts := v_sched.attempt_count + 1;
  if (p_error->>'retryAfterSeconds') is not null then
    v_retry_after := p_now + make_interval(secs => greatest((p_error->>'retryAfterSeconds')::numeric, 0)::int);
  end if;

  if v_attempts >= v_max then
    -- Exhausted: flag it, then keep trying at the normal cadence so it heals on its own.
    v_state := 'needs_attention';
    v_next := p_now + make_interval(secs => v_sched.cadence_seconds);
  else
    v_state := 'retrying';
    v_backoff := least(v_sched.cadence_seconds, 300 * power(2, v_attempts - 1)) * (0.75 + 0.5 * v_jitter);
    v_backoff := least(v_backoff, v_sched.cadence_seconds);
    v_next := p_now + make_interval(secs => v_backoff::int);
  end if;
  if v_retry_after is not null and v_retry_after > v_next then
    v_next := v_retry_after;
  end if;

  update theia.source_schedules
     set attempt_count = v_attempts,
         retry_after = v_retry_after,
         state = v_state,
         last_error = left(coalesce(p_error->>'message', 'unknown error'), 500),
         lease_token = null,
         leased_until = null,
         next_due_at = v_next,
         updated_at = p_now
   where source_key = p_source_key;

  return jsonb_build_object('leaseValid', true, 'attemptCount', v_attempts, 'state', v_state, 'nextDueAt', v_next);
end $$;

-- Recomputes the derived columns of stories from their member articles.
create or replace function theia.sync_story_aggregates(p_story_ids uuid[], p_now timestamptz)
returns void language sql set search_path = '' as $$
  update theia.stories s
     set first_seen_at = agg.first_at,
         last_seen_at = agg.last_at,
         representative_article_id = agg.rep,
         category = agg.cat,
         updated_at = p_now
    from (
      select sa.story_id,
             min(a.effective_at) as first_at,
             max(a.effective_at) as last_at,
             (array_agg(a.id order by a.effective_at, a.id))[1] as rep,
             coalesce(mode() within group (order by a.category) filter (where a.category <> 'other'), 'other') as cat
        from theia.story_articles sa
        join theia.articles a on a.id = sa.article_id
       where sa.story_id = any (p_story_ids)
       group by sa.story_id
    ) agg
   where s.id = agg.story_id;
$$;

create or replace function theia.sync_thread_aggregates(p_thread_ids uuid[], p_now timestamptz)
returns void language sql set search_path = '' as $$
  update theia.threads t
     set first_seen_at = agg.first_at,
         last_seen_at = agg.last_at,
         category = agg.cat,
         updated_at = p_now
    from (
      select ts.thread_id,
             min(s.first_seen_at) as first_at,
             max(s.last_seen_at) as last_at,
             coalesce(mode() within group (order by s.category) filter (where s.category <> 'other'), 'other') as cat
        from theia.thread_stories ts
        join theia.stories s on s.id = ts.story_id
       where ts.thread_id = any (p_thread_ids)
       group by ts.thread_id
    ) agg
   where t.id = agg.thread_id;
$$;

-- Everything the clustering step needs for one language, in one read.
create or replace function public.theia_clustering_input(
  p_language text, p_now timestamptz default now(), p_corpus_limit int default 15000, p_unassigned_limit int default 3000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hours int := theia.setting_num('story_window_hours', 72)::int;
  v_unassigned jsonb;
  v_stories jsonb;
  v_corpus jsonb;
begin
  -- A story closes once it has gone the full window without a new article.
  update theia.stories set closed_at = p_now, updated_at = p_now
   where closed_at is null and last_seen_at < p_now - make_interval(hours => v_hours);

  select coalesce(jsonb_agg(u.obj order by u.effective_at, u.id), '[]'::jsonb) into v_unassigned
    from (
      select a.effective_at, a.id, jsonb_build_object(
          'id', a.id, 'publisherId', a.publisher_id, 'headline', a.headline_normalized,
          'headlineOriginal', a.headline_original, 'summary', a.summary,
          'effectiveAt', a.effective_at, 'category', a.category) as obj
        from theia.articles a
       where a.language_code = p_language
         and not exists (select 1 from theia.story_articles sa where sa.article_id = a.id)
       order by a.effective_at, a.id
       limit p_unassigned_limit
    ) u;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'lastSeenAt', s.last_seen_at, 'firstSeenAt', s.first_seen_at,
      'members', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', m.id, 'publisherId', m.publisher_id, 'headline', m.headline_normalized,
            'summary', m.summary, 'effectiveAt', m.effective_at)), '[]'::jsonb)
          from (
            select a.id, a.publisher_id, a.headline_normalized, a.summary, a.effective_at
              from theia.story_articles sa join theia.articles a on a.id = sa.article_id
             where sa.story_id = s.id
             order by a.effective_at desc
             limit 40
          ) m)
    )), '[]'::jsonb) into v_stories
    from theia.stories s
   where s.language_code = p_language and s.closed_at is null;

  select coalesce(jsonb_agg(c.headline_normalized), '[]'::jsonb) into v_corpus
    from (
      select a.headline_normalized
        from theia.articles a
       where a.language_code = p_language and a.effective_at > p_now - interval '30 days'
       order by a.effective_at desc
       limit p_corpus_limit
    ) c;

  return jsonb_build_object('language', p_language, 'storyWindowHours', v_hours,
    'unassigned', v_unassigned, 'openStories', v_stories, 'corpus', v_corpus);
end $$;

-- Applies clustering results. Replaying the same payload changes nothing.
create or replace function public.theia_apply_clustering(
  p_language text, p_payload jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int := coalesce((p_payload->>'clusterVersion')::int, 1);
  v_map jsonb := '{}'::jsonb;
  v_key text;
  v_id uuid;
  v_new uuid[] := '{}';
  v_touched uuid[];
  v_assigned int := 0;
  v_group jsonb;
  v_group_id uuid;
  v_ids uuid[];
  v_threads uuid[];
begin
  for v_key in select jsonb_array_elements_text(coalesce(p_payload->'newStoryKeys', '[]'::jsonb)) loop
    insert into theia.stories (language_code, cluster_version, first_seen_at, last_seen_at, created_at, updated_at)
    values (p_language, v_version, p_now, p_now, p_now, p_now)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(v_key, v_id);
    v_new := v_new || v_id;
  end loop;

  with rows as (
    select coalesce(nullif(x.story_id, '')::uuid, (v_map->>x.story_key)::uuid) as story_id,
           x.article_id::uuid as article_id, x.method, x.similarity
      from jsonb_to_recordset(coalesce(p_payload->'assignments', '[]'::jsonb))
        as x(article_id text, story_id text, story_key text, similarity numeric, method text)
  ), ins as (
    insert into theia.story_articles (story_id, article_id, assigned_at, assignment_method, similarity, cluster_version)
    select r.story_id, r.article_id, p_now, r.method, r.similarity, v_version
      from rows r
      join theia.stories s on s.id = r.story_id and s.closed_at is null
      join theia.articles a on a.id = r.article_id
    on conflict (article_id) do nothing
    returning story_id
  )
  select coalesce(array_agg(distinct story_id), '{}'), count(*) into v_touched, v_assigned from ins;

  -- A new story whose articles were all claimed by a concurrent run is dropped.
  delete from theia.stories s
   where s.id = any (v_new)
     and not exists (select 1 from theia.story_articles sa where sa.story_id = s.id);

  perform theia.sync_story_aggregates(v_touched, p_now);

  select coalesce(array_agg(distinct ts.thread_id), '{}') into v_threads
    from theia.thread_stories ts where ts.story_id = any (v_touched);
  perform theia.sync_thread_aggregates(v_threads, p_now);

  -- Syndication: near-identical headlines from different publishers share a group id.
  for v_group in select * from jsonb_array_elements(coalesce(p_payload->'syndication', '[]'::jsonb)) loop
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(v_group) x;
    select a.syndication_group_id into v_group_id
      from theia.articles a
     where a.id = any (v_ids) and a.syndication_group_id is not null
     order by a.syndication_group_id
     limit 1;
    if v_group_id is null then
      v_group_id := gen_random_uuid();
    end if;
    update theia.articles set syndication_group_id = v_group_id, updated_at = p_now
     where id = any (v_ids) and syndication_group_id is null;
  end loop;

  return jsonb_build_object('assigned', v_assigned, 'storiesTouched', coalesce(array_length(v_touched, 1), 0));
end $$;

-- Stories that need a thread decision: those with no thread yet, and open threads of
-- one whose story has gained articles since it was last evaluated.
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

  return jsonb_build_object('language', p_language, 'stories', v_result);
end $$;

-- For each story signature, the threads inside the reopen window that share at least
-- two terms with it. Scoring and the final decision happen in the pipeline code.
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
     where th.language_code = p_language
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

-- Applies thread decisions: new threads, links, moves out of a thread of one, signature updates.
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
      delete from theia.threads where id = v_current;
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
    continue when v_target is null or not exists (select 1 from theia.threads where id = v_target);
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
     and not exists (select 1 from theia.thread_stories ts where ts.thread_id = t.id);

  perform theia.sync_thread_aggregates(v_touched, p_now);

  return jsonb_build_object('threadsCreated', v_created, 'linked', v_linked, 'reignited', v_reignited);
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
