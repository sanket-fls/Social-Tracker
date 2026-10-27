-- Social Command: database schema for Supabase.
-- Run once in the Supabase SQL editor (Project > SQL editor > New query > paste > Run).

-- 1. Every record lives in one document table, keyed by (collection, id).
--    Collections: queue, accounts, runs, snapshots, requests, sync, insights, config, people.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_status_idx on public.docs (collection, (data->>'status'));

-- 2. Who counts as the team. Patterns use SQL LIKE, so '%@yourcompany.com' lets the whole domain in.
--    CHANGE THIS to your own email domain before running (or add people one by one below).
create table if not exists public.team_emails (pattern text primary key);
insert into public.team_emails (pattern) values ('%@yourcompany.com') on conflict do nothing;
-- Add individual people outside the domain like this:
-- insert into public.team_emails (pattern) values ('someone@gmail.com');

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_emails t
    where lower(coalesce(auth.jwt()->>'email','')) like lower(t.pattern)
  );
$$;

-- 3. Row-level security: signed-in team members read everything and can edit queue and request docs.
--    Everything else (sync, runs, accounts, insights) is written only by the server.
alter table public.docs enable row level security;
alter table public.team_emails enable row level security;

drop policy if exists "team reads" on public.docs;
create policy "team reads" on public.docs for select to authenticated using (public.is_team());

drop policy if exists "team writes queue" on public.docs;
create policy "team writes queue" on public.docs for insert to authenticated
  with check (public.is_team() and collection in ('queue','requests','people'));

drop policy if exists "team updates queue" on public.docs;
create policy "team updates queue" on public.docs for update to authenticated
  using (public.is_team() and collection in ('queue','requests','people'))
  with check (public.is_team() and collection in ('queue','requests','people'));
-- No delete policy: nothing is deleted from the dashboard.
-- Removes visitor rules left by an earlier open-access experiment.
drop policy if exists "open reads" on public.docs;
drop policy if exists "open writes queue" on public.docs;
drop policy if exists "open updates queue" on public.docs;

-- 4. Keep updated_at fresh.
create or replace function public.touch_docs() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.touch_docs();

-- 5. Stop the team (and visitors, in open access) from changing fields only the server may set (Post for Me ids, live links).
create or replace function public.guard_queue() returns trigger language plpgsql as $$
begin
  if new.collection = 'queue' and coalesce(auth.role(),'') in ('authenticated','anon') then
    if tg_op = 'UPDATE' then
      new.data = new.data
        || jsonb_strip_nulls(jsonb_build_object(
             'pfm_post_id', old.data->'pfm_post_id',
             'live_url', old.data->'live_url',
             'scheduled_in_pfm_at', old.data->'scheduled_in_pfm_at',
             'publishing_at', old.data->'publishing_at'));
      if old.data->>'status' in ('scheduled','published') then
        new.data = jsonb_set(new.data, '{status}', old.data->'status');
      end if;
    else
      new.data = new.data - 'pfm_post_id' - 'live_url' - 'scheduled_in_pfm_at' - 'publishing_at';
      if new.data->>'status' in ('scheduled','published') then
        new.data = jsonb_set(new.data, '{status}', '"awaiting"');
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs for each row execute function public.guard_queue();

-- 6. Claim a post before sending it to Post for Me, so two workers can never post it twice.
create or replace function public.claim_post(p_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.docs
     set data = data || jsonb_build_object('publishing_at', to_jsonb(now()))
   where collection = 'queue' and id = p_id
     and data->>'status' = 'approved'
     and coalesce((data->>'hold')::boolean, false) = false
     and coalesce(data->>'pfm_post_id','') = ''
     and (data->>'publishing_at' is null or (data->>'publishing_at')::timestamptz < now() - interval '10 minutes');
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.claim_post(text) from public, anon, authenticated;
grant execute on function public.claim_post(text) to service_role;

-- 7. Live updates: every open dashboard hears changes instantly.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
alter table public.docs replica identity full;

-- 8. Media bucket (public, unguessable file names; posts are public once live anyway).
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 52428800)
on conflict (id) do nothing;

drop policy if exists "team uploads media" on storage.objects;
create policy "team uploads media" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_team());
drop policy if exists "open uploads media" on storage.objects;
