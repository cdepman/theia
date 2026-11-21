-- Project Theia: read functions behind the API. Each is a bounded lookup.

create or replace function public.theia_meta()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'code', c.code, 'name', c.name, 'collectionStartedAt', c.collection_started_at,
          'monitoredPublisherCount', (select count(*) from theia.publishers p where p.country_code = c.code and p.enabled),
          'candidatePublisherCount', (select count(*) from theia.publishers p where p.country_code = c.code)
        ) order by c.sort_order), '[]'::jsonb)
        from theia.countries c),
    'categories', jsonb_build_array('all', 'politics', 'business', 'technology', 'science', 'health',
      'entertainment', 'sports', 'environment', 'other'),
    'windows', jsonb_build_array('24h', '7d', '30d'),
    'publisherFloor', theia.setting_num('publisher_floor', 10));
$$;

-- One primary-key read of the precomputed payload, plus its freshness.
create or replace function public.theia_get_view(p_country text, p_category text, p_window text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select v.payload || jsonb_build_object('freshness', jsonb_build_object(
      'computedAt', v.computed_at,
      'ageSeconds', greatest(extract(epoch from (p_now - v.computed_at)), 0)::int,
      'refreshTargetSeconds', theia.setting_num('view_refresh_target_seconds', 14400),
      'stale', v.computed_at < p_now - make_interval(secs => theia.setting_num('view_refresh_target_seconds', 14400)::int)))
    from theia.cached_views v
   where v.cache_key = theia.view_cache_key(p_country, p_category, p_window);
$$;

create or replace function public.theia_get_story(
  p_story uuid, p_country text, p_limit int default 50, p_offset int default 0, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_story theia.stories%rowtype;
  v_headline text;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  select * into v_story from theia.stories where id = p_story;
  if not found then
    return null;
  end if;

  select a.headline_original into v_headline
    from theia.story_articles sa
    join theia.articles a on a.id = sa.article_id
    join theia.publishers p on p.id = a.publisher_id
   where sa.story_id = p_story
   order by (p.country_code = p_country) desc, a.effective_at, a.id
   limit 1;

  return jsonb_build_object(
    'id', v_story.id,
    'unit', 'story',
    'country', p_country,
    'language', v_story.language_code,
    'category', v_story.category,
    'headline', v_headline,
    'firstSeenAt', v_story.first_seen_at,
    'lastSeenAt', v_story.last_seen_at,
    'closedAt', v_story.closed_at,
    'thread', (
      select jsonb_build_object('id', t.id, 'label', t.label,
               'storyCount', (select count(*) from theia.thread_stories x where x.thread_id = t.id))
        from theia.thread_stories ts join theia.threads t on t.id = ts.thread_id
       where ts.story_id = p_story),
    'windows', (
      select jsonb_object_agg(w.code, jsonb_build_object(
          'publisherCount', (
            select count(distinct a.publisher_id)
              from theia.story_articles sa
              join theia.articles a on a.id = sa.article_id
              join theia.publishers p on p.id = a.publisher_id
             where sa.story_id = p_story and p.country_code = p_country
               and a.effective_at > p_now - w.span and a.effective_at <= p_now),
          'articleCount', (
            select count(*)
              from theia.story_articles sa
              join theia.articles a on a.id = sa.article_id
              join theia.publishers p on p.id = a.publisher_id
             where sa.story_id = p_story and p.country_code = p_country
               and a.effective_at > p_now - w.span and a.effective_at <= p_now)))
        from (values ('24h', interval '24 hours'), ('7d', interval '7 days'), ('30d', interval '30 days')) as w(code, span)),
    'byCountry', (
      select coalesce(jsonb_agg(jsonb_build_object('country', q.country_code, 'publisherCount', q.pubs, 'articleCount', q.arts)
               order by q.pubs desc, q.country_code), '[]'::jsonb)
        from (
          select p.country_code, count(distinct a.publisher_id) as pubs, count(*) as arts
            from theia.story_articles sa
            join theia.articles a on a.id = sa.article_id
            join theia.publishers p on p.id = a.publisher_id
           where sa.story_id = p_story
           group by p.country_code
        ) q),
    'stats', theia.story_stats(p_story, p_country, p_now),
    'articles', jsonb_build_object(
      'total', (select count(*) from theia.story_articles sa where sa.story_id = p_story),
      'limit', v_limit,
      'offset', v_offset,
      'items', (
        select coalesce(jsonb_agg(r.obj order by r.ord), '[]'::jsonb)
          from (
            select row_number() over (order by (p.country_code = p_country) desc, a.effective_at desc, a.id) as ord,
                   jsonb_build_object(
                     'id', a.id, 'headline', a.headline_original, 'url', a.original_url,
                     'language', a.language_code, 'category', a.category,
                     'publishedAt', a.published_at, 'firstObservedAt', a.first_observed_at, 'effectiveAt', a.effective_at,
                     'syndicationGroupId', a.syndication_group_id,
                     'publisher', jsonb_build_object('name', p.name, 'domain', p.domain, 'country', p.country_code,
                       'isWire', p.is_wire, 'attributionMethod', p.country_attribution_method)) as obj
              from theia.story_articles sa
              join theia.articles a on a.id = sa.article_id
              join theia.publishers p on p.id = a.publisher_id
             where sa.story_id = p_story
             order by (p.country_code = p_country) desc, a.effective_at desc, a.id
             limit v_limit offset v_offset
          ) r)));
end $$;

create or replace function public.theia_get_thread(p_thread uuid, p_country text, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_thread theia.threads%rowtype;
begin
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
          select c.country_code, sum(c.distinct_publisher_count) as pd, count(*) as ad
            from theia.thread_daily_coverage c
           where c.thread_id = p_thread and c.day > (p_now at time zone 'UTC')::date - 30
           group by c.country_code
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

-- The monitored source set for a country, with per-feed health.
create or replace function public.theia_coverage(p_country text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'country', p_country,
    'collectionStartedAt', (select collection_started_at from theia.countries where code = p_country),
    'coverage', jsonb_build_object(
      '24h', theia.coverage_block(p_country, p_now - interval '24 hours', p_now),
      '7d', theia.coverage_block(p_country, p_now - interval '7 days', p_now),
      '30d', theia.coverage_block(p_country, p_now - interval '30 days', p_now)),
    'publishers', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'name', p.name, 'domain', p.domain, 'enabled', p.enabled, 'isWire', p.is_wire,
          'languages', to_jsonb(p.languages), 'termsStatus', p.terms_status, 'termsUrl', p.terms_url,
          'attributionMethod', p.country_attribution_method,
          'articleCount30d', (
            select count(*) from theia.articles a
             where a.publisher_id = p.id and a.effective_at > p_now - interval '30 days'),
          'feeds', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'section', f.section_label, 'language', f.language_code, 'enabled', f.enabled,
                'state', s.state, 'lastSuccessAt', s.last_success_at, 'lastNewArticleAt', s.last_new_article_at,
                'nextDueAt', s.next_due_at, 'attemptCount', s.attempt_count
              ) order by f.section_label), '[]'::jsonb)
              from theia.publisher_feeds f
              left join theia.source_schedules s on s.publisher_feed_id = f.id
             where f.publisher_id = p.id)
        ) order by p.enabled desc, p.name), '[]'::jsonb)
        from theia.publishers p
       where p.country_code = p_country),
    'gaps', (
      select coalesce(jsonb_agg(jsonb_build_object('sourceKey', g.source_key, 'start', g.gap_start, 'end', g.gap_end,
               'reason', g.reason) order by g.gap_end desc), '[]'::jsonb)
        from (
          select * from theia.coverage_gaps
           where country_code = p_country and gap_end > p_now - interval '30 days'
           order by gap_end desc limit 50
        ) g));
$$;

-- The three alert conditions, in one small read. Used by the external freshness check.
create or replace function public.theia_data_status(p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_max_beat int := theia.setting_num('dispatcher_heartbeat_max_seconds', 2700)::int;
  v_target int := theia.setting_num('view_refresh_target_seconds', 14400)::int;
  v_paused boolean := theia.setting_bool('dispatch_paused', false);
  v_beat timestamptz;
  v_problems jsonb := '[]'::jsonb;
  v_countries jsonb;
  v_attention jsonb;
  v_active_sources int;
begin
  select last_beat_at into v_beat from theia.pipeline_heartbeats where component = 'dispatcher';
  select count(*) into v_active_sources
    from theia.source_schedules s
    join theia.publisher_feeds f on f.id = s.publisher_feed_id
    join theia.publishers p on p.id = f.publisher_id
   where s.state <> 'disabled' and f.enabled and p.enabled;

  if v_active_sources > 0 and (v_beat is null or v_beat < p_now - make_interval(secs => v_max_beat)) then
    v_problems := v_problems || jsonb_build_object('code', 'dispatcher_heartbeat_stale', 'lastBeatAt', v_beat);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'code', c.code, 'monitoredPublisherCount', q.monitored, 'lastComputedAt', q.computed_at,
      'dataAsOf', q.data_as_of,
      'viewAgeSeconds', case when q.computed_at is null then null
                             else greatest(extract(epoch from (p_now - q.computed_at)), 0)::int end,
      'stale', q.monitored > 0 and (q.computed_at is null or q.computed_at < p_now - make_interval(secs => v_target))
    ) order by c.sort_order), '[]'::jsonb) into v_countries
    from theia.countries c
   cross join lateral (
     select (select count(*) from theia.publishers p where p.country_code = c.code and p.enabled) as monitored,
            (select max(v.computed_at) from theia.cached_views v where v.country_code = c.code) as computed_at,
            (select max(v.data_as_of) from theia.cached_views v where v.country_code = c.code) as data_as_of
   ) q;

  select v_problems || coalesce(jsonb_agg(jsonb_build_object('code', 'views_stale', 'country', e->>'code')), '[]'::jsonb)
    into v_problems
    from jsonb_array_elements(v_countries) e
   where (e->>'stale')::boolean;

  select coalesce(jsonb_agg(s.source_key order by s.source_key), '[]'::jsonb) into v_attention
    from theia.source_schedules s where s.state = 'needs_attention';
  if jsonb_array_length(v_attention) > 0 then
    v_problems := v_problems || jsonb_build_object('code', 'sources_need_attention', 'sources', v_attention);
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_problems) = 0,
    'checkedAt', p_now,
    'paused', v_paused,
    'activeSourceCount', v_active_sources,
    'dispatcher', jsonb_build_object('lastBeatAt', v_beat,
      'ageSeconds', case when v_beat is null then null else greatest(extract(epoch from (p_now - v_beat)), 0)::int end),
    'countries', v_countries,
    'sourcesNeedingAttention', v_attention,
    'problems', v_problems);
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
      'threads', (select count(*) from theia.threads),
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
