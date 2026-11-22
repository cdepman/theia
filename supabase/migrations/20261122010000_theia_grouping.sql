-- Project Theia: grouping as a presentation layer.
--
-- Articles are the record. Which articles form an event, which events form a subject, and
-- what each is called are judgments about that record, and judgments can be redone.
--
--   theia.grouping_decisions  the judgment log: one row per article per grouper. A grouper
--                             is a named method, such as 'llm-v1'. A later model or prompt
--                             writes under a new name, beside the earlier judgments.
--   theia.stories / threads   the projection: what the app currently shows. It is rebuilt
--                             from one grouper's decisions by theia_apply_grouping and
--                             can be rebuilt from another's at any time.
--
-- Nothing here changes an article.

alter table theia.stories
  add column label text,
  add column grouper text not null default 'lexical-v1',
  add column event_key text;
create unique index stories_event_key_idx on theia.stories (grouper, event_key) where event_key is not null;

alter table theia.threads
  add column grouper text not null default 'lexical-v1',
  add column subject_key text;
create unique index threads_subject_key_idx on theia.threads (grouper, subject_key) where subject_key is not null;

create table theia.grouping_decisions (
  grouper text not null,
  article_id uuid not null references theia.articles (id) on delete cascade,
  language_code text not null,
  event_key text not null,
  event_label text not null,
  subject_key text not null,
  subject_label text not null,
  category text,
  confidence text not null check (confidence in ('high', 'low')),
  model text not null,
  escalated boolean not null default false,
  decided_at timestamptz not null,
  primary key (grouper, article_id)
);
create index grouping_decisions_event_idx on theia.grouping_decisions (grouper, language_code, event_key);
alter table theia.grouping_decisions enable row level security;

-- Appends judgments to the log. A grouper judging the same article again replaces its own
-- earlier judgment; other groupers' judgments are untouched.
create or replace function public.theia_record_decisions(
  p_grouper text, p_language text, p_decisions jsonb, p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  insert into theia.grouping_decisions as g (grouper, article_id, language_code, event_key, event_label, subject_key,
    subject_label, category, confidence, model, escalated, decided_at)
  select p_grouper, a.id, p_language, x."eventKey", left(x."eventLabel", 200), x."subjectKey", left(x."subjectLabel", 200),
         case when x.category in ('politics', 'business', 'technology', 'science', 'health', 'entertainment',
           'sports', 'environment', 'other') then x.category else 'other' end,
         case when x.confidence = 'low' then 'low' else 'high' end, coalesce(x.model, 'unknown'), coalesce(x.escalated, false), p_now
    from jsonb_to_recordset(coalesce(p_decisions, '[]'::jsonb)) as x(
      "articleId" uuid, "eventKey" text, "eventLabel" text, "subjectKey" text, "subjectLabel" text,
      category text, confidence text, model text, escalated boolean)
    join theia.articles a on a.id = x."articleId"
   where x."eventKey" is not null and x."subjectKey" is not null
     and length(trim(coalesce(x."eventLabel", ''))) > 0 and length(trim(coalesce(x."subjectLabel", ''))) > 0
  on conflict (grouper, article_id) do update set
    event_key = excluded.event_key, event_label = excluded.event_label, subject_key = excluded.subject_key,
    subject_label = excluded.subject_label, category = excluded.category, confidence = excluded.confidence,
    model = excluded.model, escalated = excluded.escalated, decided_at = excluded.decided_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Projects one grouper's decisions for one language onto stories and threads. Every
-- article that grouper has judged ends up in the story for its event, every such story in
-- the thread for its subject, labels and categories follow the decisions, and stories or
-- threads left empty are removed. Articles the grouper has not judged stay where they are.
-- Running it twice changes nothing the second time.
create or replace function public.theia_apply_grouping(
  p_grouper text, p_language text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_moved int := 0;
  v_stories uuid[];
  v_threads uuid[];
  v_removed_stories int := 0;
  v_removed_threads int := 0;
begin
  drop table if exists pg_temp._events, pg_temp._subjects;
  -- One label, subject and category per event: the most common among its decisions.
  create temp table _events on commit drop as
  select d.event_key,
         mode() within group (order by d.event_label) as label,
         mode() within group (order by d.subject_key) as subject_key,
         mode() within group (order by d.category) as category
    from theia.grouping_decisions d
   where d.grouper = p_grouper and d.language_code = p_language
   group by d.event_key;

  create temp table _subjects on commit drop as
  select e.subject_key, mode() within group (order by d.subject_label) as label
    from _events e
    join theia.grouping_decisions d on d.grouper = p_grouper and d.language_code = p_language and d.subject_key = e.subject_key
   group by e.subject_key;

  insert into theia.threads (language_code, label, signature, first_seen_at, last_seen_at, thread_version, grouper, subject_key, created_at, updated_at)
  select p_language, s.label, '{}'::jsonb, p_now, p_now, 1, p_grouper, s.subject_key, p_now, p_now
    from _subjects s
   where not exists (select 1 from theia.threads t where t.grouper = p_grouper and t.subject_key = s.subject_key);
  update theia.threads t set label = s.label, updated_at = p_now
    from _subjects s
   where t.grouper = p_grouper and t.subject_key = s.subject_key and t.label is distinct from s.label;

  insert into theia.stories (language_code, cluster_version, first_seen_at, last_seen_at, grouper, event_key, label, created_at, updated_at)
  select p_language, 1, p_now, p_now, p_grouper, e.event_key, e.label, p_now, p_now
    from _events e
   where not exists (select 1 from theia.stories s where s.grouper = p_grouper and s.event_key = e.event_key);
  update theia.stories s set label = e.label, updated_at = p_now
    from _events e
   where s.grouper = p_grouper and s.event_key = e.event_key and s.label is distinct from e.label;

  -- Articles move to the story for their event.
  with target as (
    select d.article_id, s.id as story_id
      from theia.grouping_decisions d
      join theia.stories s on s.grouper = p_grouper and s.event_key = d.event_key
     where d.grouper = p_grouper and d.language_code = p_language
  ), moved as (
    update theia.story_articles sa
       set story_id = t.story_id, assigned_at = p_now, assignment_method = p_grouper, similarity = null
      from target t
     where sa.article_id = t.article_id and sa.story_id <> t.story_id
    returning 1
  ), added as (
    insert into theia.story_articles (story_id, article_id, assigned_at, assignment_method, cluster_version)
    select t.story_id, t.article_id, p_now, p_grouper, 1
      from target t
     where not exists (select 1 from theia.story_articles sa where sa.article_id = t.article_id)
    on conflict (article_id) do nothing
    returning 1
  )
  select (select count(*) from moved) + (select count(*) from added) into v_moved;

  -- Stories sit in the thread for their subject.
  with target as (
    select s.id as story_id, t.id as thread_id
      from _events e
      join theia.stories s on s.grouper = p_grouper and s.event_key = e.event_key
      join theia.threads t on t.grouper = p_grouper and t.subject_key = e.subject_key
  ), relinked as (
    update theia.thread_stories ts
       set thread_id = tg.thread_id, linked_at = p_now, evaluated_at = p_now, link_method = p_grouper, link_score = null
      from target tg
     where ts.story_id = tg.story_id and ts.thread_id <> tg.thread_id
    returning 1
  )
  insert into theia.thread_stories (thread_id, story_id, linked_at, evaluated_at, link_method, thread_version)
  select tg.thread_id, tg.story_id, p_now, p_now, p_grouper, 1
    from target tg
   where not exists (select 1 from theia.thread_stories ts where ts.story_id = tg.story_id)
  on conflict (story_id) do nothing;

  -- Whatever the regrouping emptied is removed. The decisions that describe it remain.
  with gone as (
    delete from theia.stories s
     where s.language_code = p_language
       and not exists (select 1 from theia.story_articles sa where sa.story_id = s.id)
    returning 1
  )
  select count(*) into v_removed_stories from gone;
  with gone as (
    delete from theia.threads t
     where t.language_code = p_language
       and not exists (select 1 from theia.thread_stories ts where ts.thread_id = t.id)
       -- Merge markers left by earlier thread merges stay, so old links still resolve.
       -- A thread with recorded rank history, or one that marks an earlier merge, is kept
       -- as an empty row so that history and old links still resolve.
       and t.merged_into_id is null
       and not exists (select 1 from theia.threads x where x.merged_into_id = t.id)
       and not exists (select 1 from theia.thread_metric_snapshots m where m.thread_id = t.id)
    returning 1
  )
  select count(*) into v_removed_threads from gone;

  select coalesce(array_agg(s.id), '{}') into v_stories from theia.stories s where s.language_code = p_language;
  perform theia.sync_story_aggregates(v_stories, p_now);
  -- The grouper's category stands in place of the keyword rule's.
  update theia.stories s set category = e.category
    from _events e
   where s.grouper = p_grouper and s.event_key = e.event_key and e.category is not null and s.category is distinct from e.category;
  select coalesce(array_agg(t.id), '{}') into v_threads from theia.threads t where t.language_code = p_language;
  perform theia.sync_thread_aggregates(v_threads, p_now);

  return jsonb_build_object('grouper', p_grouper, 'language', p_language,
    'events', (select count(*) from _events), 'subjects', (select count(*) from _subjects),
    'articlesPlaced', v_moved, 'storiesRemoved', v_removed_stories, 'threadsRemoved', v_removed_threads);
end $$;

-- Short model-written labels for stories and subjects, attached when a view is served.
-- Keeping them out of the cached views means a relabel shows at once, without recomputing
-- anything. Threads named by the keyword method are left out: those names are term lists.
create or replace function public.theia_short_labels(p_ids jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with ids as (select x::uuid as id from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) x)
  select coalesce(jsonb_object_agg(q.id, q.label), '{}'::jsonb)
    from (
      select s.id, s.label from theia.stories s join ids on ids.id = s.id where s.label is not null
      union all
      select t.id, t.label from theia.threads t join ids on ids.id = t.id
       where t.grouper <> 'lexical-v1' and length(coalesce(t.label, '')) > 0
    ) q;
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
