-- Social Command: the 10-minute background loop, run by the database itself.
-- Supabase calls GET <your app>/api/cron every 10 minutes (pg_cron + pg_net), with the app's address and
-- CRON_SECRET read from Supabase Vault. GitHub Actions (docs/github-actions/tick.yml) can be a slower backup.
--
-- BEFORE YOU RUN THIS
--   1. Open the project where you ran schema.sql (top-left project picker).
--   2. Add two secrets in Vault (once): Integrations > Vault > Secrets > Add new secret
--        Name:  social_tracker_cron_secret   Value: the CRON_SECRET from Vercel (Project > Settings > Environment Variables)
--        Name:  social_tracker_app_url       Value: your app's address, e.g. https://your-app.vercel.app (no trailing slash)
--      Use the Vault screen rather than SQL, so the secret never sits in your saved SQL snippets.
--   3. SQL editor > New query > paste this whole file > Run. Safe to run again; it replaces the job.
--
-- It stops without changing anything if this is not the Social Command database or a secret is missing.

-- 1. Make sure this is the Social Command database.
do $$
begin
  if to_regclass('public.docs') is null or to_regclass('public.team_emails') is null then
    raise exception 'Wrong project: run supabase/schema.sql in this project first (or switch to the project where you did).';
  end if;
end $$;

-- 2. Extensions: the scheduler, outgoing HTTP, and Vault (on by default in new projects).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'social_tracker_cron_secret') then
    raise exception 'Vault secret social_tracker_cron_secret not found. Add it under Integrations > Vault, then run this again.';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'social_tracker_app_url' and decrypted_secret like 'https://%') then
    raise exception 'Vault secret social_tracker_app_url (your app address, starting https://) not found. Add it under Integrations > Vault, then run this again.';
  end if;
end $$;

-- 3. One call of the loop. Lives in a schema the website API cannot reach, so only the database runs it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.social_tracker_tick(force_sync boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
  app text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'social_tracker_cron_secret';
  select rtrim(decrypted_secret, '/') into app from vault.decrypted_secrets where name = 'social_tracker_app_url';
  if secret is null or app is null then
    raise exception 'Vault secrets social_tracker_cron_secret / social_tracker_app_url are missing';
  end if;
  -- pg_net sends this after the transaction commits and records the answer in net._http_response.
  return net.http_get(
    url := app || '/api/cron?src=supabase' || case when force_sync then '&sync=1' else '' end,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 300000
  );
end $$;
revoke all on function private.social_tracker_tick(boolean) from public, anon, authenticated;

-- 4. Every 10 minutes, around the clock (times are UTC). Scheduling under the same name replaces the old job.
select cron.schedule('social-tracker-tick', '*/10 * * * *', $job$select private.social_tracker_tick()$job$);

-- 5. One call right now, so you can see it work without waiting. Within a minute the dashboard's
--    Help > Run log shows "Background loop: first run from the Supabase scheduler".
select private.social_tracker_tick() as request_id;

-- CHECKING ON IT LATER (run these on their own)
--   Is the job there?            select jobid, schedule, active from cron.job where jobname = 'social-tracker-tick';
--   Did it fire?                 select start_time, status, return_message from cron.job_run_details
--                                  where jobid = (select jobid from cron.job where jobname = 'social-tracker-tick')
--                                  order by start_time desc limit 10;
--   What did the app answer?     select created, status_code, left(content::text, 300) as body, error_msg
--                                  from net._http_response order by created desc limit 10;
--                                (200 = fine, 401 = the Vault secret does not match CRON_SECRET on Vercel)
--
-- CHANGED CRON_SECRET ON VERCEL?  Integrations > Vault > edit social_tracker_cron_secret. Nothing else to do.
-- MOVED THE APP?                 Integrations > Vault > edit social_tracker_app_url.
-- TURN IT OFF                     select cron.unschedule('social-tracker-tick');
