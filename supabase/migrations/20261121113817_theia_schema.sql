-- Project Theia: schema.
-- Tables live in the private `theia` schema, which the Data API does not expose.
-- Server code reaches them only through the `public.theia_*` functions, which are
-- executable by `service_role` alone (see the grants at the end of each migration).

create schema if not exists theia;

create table theia.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  sort_order int not null default 0,
  collection_started_at timestamptz
);

insert into theia.countries (code, name, sort_order) values
  ('US', 'United States', 1),
  ('GB', 'United Kingdom', 2),
  ('JP', 'Japan', 3);

create table theia.data_sources (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('rss', 'gdelt')),
  name text not null unique,
  endpoint text,
  license_notes text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table theia.publishers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  domain text not null unique,
  country_code text references theia.countries (code),
  country_attribution_method text,
  country_attribution_confidence numeric,
  languages text[] not null default '{}',
  is_wire boolean not null default false,
  terms_status text,
  terms_url text,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table theia.publisher_feeds (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references theia.publishers (id) on delete cascade,
  data_source_id uuid not null references theia.data_sources (id),
  feed_url text not null unique,
  language_code text not null,
  section_label text,
  default_category text,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per independently polled source. The lease on this row is the only
-- concurrency control for polling: there is no job table and no queue.
create table theia.source_schedules (
  source_key text primary key,
  publisher_feed_id uuid references theia.publisher_feeds (id) on delete cascade,
  data_source_id uuid not null references theia.data_sources (id),
  cadence_seconds int not null default 10800 check (cadence_seconds >= 300),
  freshness_target_seconds int not null default 14400,
  next_due_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  attempt_count int not null default 0,
  retry_after timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_new_article_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb,
  state text not null default 'ok' check (state in ('ok', 'retrying', 'needs_attention', 'disabled')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index source_schedules_due_idx on theia.source_schedules (next_due_at) where state <> 'disabled';

create table theia.articles (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null default 'rss',
  provider_record_id text,
  normalized_url text not null unique,
  original_url text not null,
  headline_original text not null,
  headline_normalized text not null,
  summary text,
  publisher_id uuid not null references theia.publishers (id),
  language_code text not null,
  published_at timestamptz,
  -- When Theia first saw the article. Never updated after insert.
  first_observed_at timestamptz not null,
  -- Timestamp used for all window math: published_at when it is present and not
  -- later than first_observed_at, otherwise first_observed_at.
  effective_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  category text not null default 'other',
  category_method text,
  category_version int,
  syndication_group_id uuid,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint articles_category_check check (category in
    ('politics', 'business', 'technology', 'science', 'health', 'entertainment', 'sports', 'environment', 'other')),
  constraint articles_effective_check check (effective_at <= first_observed_at)
);
create index articles_effective_idx on theia.articles (effective_at desc);
create index articles_publisher_effective_idx on theia.articles (publisher_id, effective_at desc);
create index articles_language_effective_idx on theia.articles (language_code, effective_at desc);
create index articles_ingested_idx on theia.articles (ingested_at desc);

create table theia.stories (
  id uuid primary key default gen_random_uuid(),
  language_code text not null,
  representative_article_id uuid references theia.articles (id),
  category text not null default 'other',
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  closed_at timestamptz,
  cluster_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stories_open_idx on theia.stories (language_code, last_seen_at desc) where closed_at is null;

-- Each article belongs to exactly one story.
create table theia.story_articles (
  story_id uuid not null references theia.stories (id) on delete cascade,
  article_id uuid not null unique references theia.articles (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assignment_method text,
  similarity numeric,
  cluster_version int not null default 1,
  primary key (story_id, article_id)
);

-- A thread is the enduring subject that links related stories.
create table theia.threads (
  id uuid primary key default gen_random_uuid(),
  language_code text not null,
  label text not null default '',
  signature jsonb not null default '{}'::jsonb,
  category text not null default 'other',
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  dormant_at timestamptz,
  thread_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_language_seen_idx on theia.threads (language_code, last_seen_at desc);

-- Every story belongs to exactly one thread; a story that links to nothing is a thread of one.
create table theia.thread_stories (
  thread_id uuid not null references theia.threads (id) on delete cascade,
  story_id uuid not null unique references theia.stories (id) on delete cascade,
  linked_at timestamptz not null default now(),
  evaluated_at timestamptz not null default now(),
  link_method text,
  link_score numeric,
  thread_version int not null default 1,
  primary key (thread_id, story_id)
);

-- Inverted index of thread signature terms, used to find link candidates in SQL.
create table theia.thread_terms (
  thread_id uuid not null references theia.threads (id) on delete cascade,
  term text not null,
  weight numeric not null,
  primary key (thread_id, term)
);
create index thread_terms_term_idx on theia.thread_terms (term);

-- Append-only record of cluster and thread changes, so past snapshots stay interpretable.
create table theia.story_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in
    ('merge', 'split', 'reassign', 'recategorize', 'thread_link', 'thread_merge', 'thread_reignite')),
  story_id uuid,
  related_story_id uuid,
  thread_id uuid,
  related_thread_id uuid,
  article_id uuid,
  occurred_at timestamptz not null default now(),
  cluster_version int,
  detail jsonb not null default '{}'::jsonb
);
create index story_events_occurred_idx on theia.story_events (occurred_at desc);

-- Derived table, recomputable from articles at any time.
create table theia.thread_daily_coverage (
  thread_id uuid not null references theia.threads (id) on delete cascade,
  country_code text not null references theia.countries (code),
  day date not null,
  distinct_publisher_count int not null,
  article_count int not null,
  story_count int not null,
  coverage_status text not null default 'complete',
  computed_at timestamptz not null default now(),
  primary key (thread_id, country_code, day)
);
create index thread_daily_coverage_country_day_idx on theia.thread_daily_coverage (country_code, day);

create table theia.story_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references theia.stories (id) on delete cascade,
  country_code text not null references theia.countries (code),
  window_code text not null check (window_code in ('24h', '7d', '30d')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  observation_cutoff timestamptz not null,
  observed_at timestamptz not null default now(),
  article_count int not null,
  distinct_publisher_count int not null,
  rank int not null,
  prominence_score numeric not null,
  metric_version int not null,
  coverage_status text not null,
  unique (story_id, country_code, window_code, observation_cutoff, metric_version)
);
create index story_metric_snapshots_lookup_idx
  on theia.story_metric_snapshots (country_code, window_code, observation_cutoff desc);
create index story_metric_snapshots_story_idx on theia.story_metric_snapshots (story_id);

create table theia.thread_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references theia.threads (id) on delete cascade,
  country_code text not null references theia.countries (code),
  window_code text not null check (window_code in ('24h', '7d', '30d')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  observation_cutoff timestamptz not null,
  observed_at timestamptz not null default now(),
  publisher_days int not null,
  distinct_publisher_count int not null,
  active_days int not null,
  article_count int not null,
  story_count int not null,
  rank int not null,
  metric_version int not null,
  coverage_status text not null,
  unique (thread_id, country_code, window_code, observation_cutoff, metric_version)
);
create index thread_metric_snapshots_lookup_idx
  on theia.thread_metric_snapshots (country_code, window_code, observation_cutoff desc);

-- The exact API payload for one country/category/window.
create table theia.cached_views (
  cache_key text primary key,
  country_code text not null references theia.countries (code),
  category text not null,
  window_code text not null,
  payload jsonb not null,
  observation_cutoff timestamptz not null,
  data_as_of timestamptz,
  computed_at timestamptz not null default now(),
  expires_at timestamptz,
  schema_version int not null,
  source_coverage_status text not null
);
create index cached_views_country_idx on theia.cached_views (country_code);

-- One row per poll attempt.
create table theia.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  provider text not null default 'rss',
  country_code text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  status text not null check (status in ('success', 'unchanged', 'failed')),
  http_status int,
  records_fetched int not null default 0,
  records_inserted int not null default 0,
  records_rejected int not null default 0,
  error_summary text,
  checkpoint_after jsonb,
  metadata jsonb not null default '{}'::jsonb
);
create index ingestion_runs_source_idx on theia.ingestion_runs (source_key, started_at desc);
create index ingestion_runs_started_idx on theia.ingestion_runs (started_at desc);

-- Intervals where a source may have published items Theia never saw.
create table theia.coverage_gaps (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  country_code text,
  gap_start timestamptz not null,
  gap_end timestamptz not null,
  reason text not null,
  recorded_at timestamptz not null default now()
);
create index coverage_gaps_country_idx on theia.coverage_gaps (country_code, gap_end desc);

create table theia.pipeline_heartbeats (
  component text primary key,
  last_beat_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb
);

create table theia.pipeline_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into theia.pipeline_settings (key, value) values
  ('dispatch_paused', 'false'),
  ('story_window_hours', '72'),
  ('max_poll_attempts', '5'),
  ('article_max_age_days', '35'),
  ('thread_dormancy_days', '21'),
  ('thread_reopen_days', '90'),
  ('view_refresh_target_seconds', '14400'),
  ('dispatcher_heartbeat_max_seconds', '2700'),
  ('publisher_floor', '10'),
  ('gap_cadence_multiple', '2');

-- Defense in depth: RLS on, with no policies. The theia_* functions run as their
-- owner and are unaffected; any other role that somehow reaches a table sees nothing.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'theia' loop
    execute format('alter table theia.%I enable row level security', r.tablename);
  end loop;
end $$;

create or replace function theia.setting_num(p_key text, p_default numeric)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(
    (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric end
       from theia.pipeline_settings where key = p_key),
    p_default);
$$;

create or replace function theia.setting_bool(p_key text, p_default boolean)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(
    (select case when jsonb_typeof(value) = 'boolean' then (value #>> '{}')::boolean end
       from theia.pipeline_settings where key = p_key),
    p_default);
$$;

-- Lock the schema down for API roles where they exist (hosted Supabase).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema theia from anon, authenticated;
    revoke all on all tables in schema theia from anon, authenticated;
    revoke all on all functions in schema theia from anon, authenticated;
  end if;
  revoke all on schema theia from public;
end $$;
