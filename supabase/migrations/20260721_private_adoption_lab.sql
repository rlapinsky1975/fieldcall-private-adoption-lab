-- FieldCall private adoption lab
-- Additive only: no existing production table or scoring function is changed.

begin;

create table if not exists public.fieldcall_user_journeys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  shadow_mode_enabled boolean not null default true,
  risk_posture_confirmed_at timestamptz,
  activation_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create table if not exists public.contractor_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage text not null check (stage in ('before_fieldcall', 'final')),
  decision text not null check (decision in ('GO', 'DELAY', 'NO GO')),
  local_context text,
  fieldcall_signal text,
  decided_at timestamptz not null default now(),
  unique (job_id, user_id, stage)
);

create table if not exists public.job_outcomes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actual_decision text not null check (actual_decision in ('WORKED', 'DELAYED', 'CANCELED')),
  weather_materially_affected boolean not null,
  fieldcall_helped boolean not null,
  missing_context text,
  submitted_at timestamptz not null default now(),
  unique (job_id, user_id)
);

create table if not exists public.job_signal_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  signal text,
  score numeric,
  reason text,
  window_label text,
  is_final boolean not null default false,
  source text not null default 'job_result',
  checked_at timestamptz not null default now(),
  result_snapshot jsonb not null default '{}'::jsonb
);

create index if not exists fieldcall_user_journeys_company_user_idx
  on public.fieldcall_user_journeys(company_id, user_id);
create index if not exists contractor_decisions_company_job_idx
  on public.contractor_decisions(company_id, job_id);
create index if not exists job_outcomes_company_job_idx
  on public.job_outcomes(company_id, job_id);
create index if not exists job_signal_events_job_checked_idx
  on public.job_signal_events(job_id, checked_at desc);
create index if not exists job_signal_events_company_checked_idx
  on public.job_signal_events(company_id, checked_at desc);

alter table public.fieldcall_user_journeys enable row level security;
alter table public.contractor_decisions enable row level security;
alter table public.job_outcomes enable row level security;
alter table public.job_signal_events enable row level security;

drop policy if exists "journey_select_own_company" on public.fieldcall_user_journeys;
create policy "journey_select_own_company"
on public.fieldcall_user_journeys for select to authenticated
using (
  user_id = auth.uid()
  and exists (
    select 1 from public.company_users cu
    where cu.company_id = fieldcall_user_journeys.company_id
      and cu.user_id = auth.uid()
  )
);

drop policy if exists "journey_insert_own_company" on public.fieldcall_user_journeys;
create policy "journey_insert_own_company"
on public.fieldcall_user_journeys for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.company_users cu
    where cu.company_id = fieldcall_user_journeys.company_id
      and cu.user_id = auth.uid()
  )
);

drop policy if exists "journey_update_own_company" on public.fieldcall_user_journeys;
create policy "journey_update_own_company"
on public.fieldcall_user_journeys for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "decisions_select_own" on public.contractor_decisions;
create policy "decisions_select_own"
on public.contractor_decisions for select to authenticated
using (user_id = auth.uid());

drop policy if exists "decisions_insert_own" on public.contractor_decisions;
create policy "decisions_insert_own"
on public.contractor_decisions for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.jobs j
    where j.id = contractor_decisions.job_id
      and j.company_id = contractor_decisions.company_id
      and j.created_by = auth.uid()
  )
);

drop policy if exists "decisions_update_own" on public.contractor_decisions;
create policy "decisions_update_own"
on public.contractor_decisions for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "outcomes_select_own" on public.job_outcomes;
create policy "outcomes_select_own"
on public.job_outcomes for select to authenticated
using (user_id = auth.uid());

drop policy if exists "outcomes_insert_own" on public.job_outcomes;
create policy "outcomes_insert_own"
on public.job_outcomes for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.jobs j
    where j.id = job_outcomes.job_id
      and j.company_id = job_outcomes.company_id
      and j.created_by = auth.uid()
  )
);

drop policy if exists "outcomes_update_own" on public.job_outcomes;
create policy "outcomes_update_own"
on public.job_outcomes for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "signal_events_select_company" on public.job_signal_events;
create policy "signal_events_select_company"
on public.job_signal_events for select to authenticated
using (
  exists (
    select 1 from public.company_users cu
    where cu.company_id = job_signal_events.company_id
      and cu.user_id = auth.uid()
  )
);

grant select, insert, update on public.fieldcall_user_journeys to authenticated;
grant select, insert, update on public.contractor_decisions to authenticated;
grant select, insert, update on public.job_outcomes to authenticated;
grant select on public.job_signal_events to authenticated;

create or replace function public.capture_job_signal_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  result_checked_at timestamptz;
begin
  if new.last_result is null
     or new.last_result is not distinct from old.last_result then
    return new;
  end if;

  begin
    result_checked_at := coalesce(
      nullif(new.last_result->>'checkedAt', '')::timestamptz,
      new.last_checked_at,
      now()
    );
  exception when others then
    result_checked_at := coalesce(new.last_checked_at, now());
  end;

  insert into public.job_signal_events (
    company_id,
    job_id,
    user_id,
    signal,
    score,
    reason,
    window_label,
    is_final,
    source,
    checked_at,
    result_snapshot
  ) values (
    new.company_id,
    new.id,
    new.created_by,
    new.last_result->>'shortSignal',
    nullif(new.last_result->>'score', '')::numeric,
    new.last_result->>'reason',
    coalesce(new.last_result->>'bestWindowLabel', new.last_result->>'window'),
    coalesce((new.last_result->>'isFinal')::boolean, false),
    coalesce(new.last_result->>'finalCallSource', 'job_result'),
    result_checked_at,
    new.last_result
  );

  return new;
end;
$$;

drop trigger if exists jobs_capture_signal_event on public.jobs;
create trigger jobs_capture_signal_event
after update of last_result on public.jobs
for each row execute function public.capture_job_signal_event();

-- Seed one history point for each existing job with a current result so the
-- private test dashboard is useful immediately. Re-running is idempotent.
insert into public.job_signal_events (
  company_id, job_id, user_id, signal, score, reason, window_label,
  is_final, source, checked_at, result_snapshot
)
select
  j.company_id,
  j.id,
  j.created_by,
  j.last_result->>'shortSignal',
  nullif(j.last_result->>'score', '')::numeric,
  j.last_result->>'reason',
  coalesce(j.last_result->>'bestWindowLabel', j.last_result->>'window'),
  coalesce((j.last_result->>'isFinal')::boolean, false),
  'migration_seed',
  coalesce(j.last_checked_at, j.updated_at, now()),
  j.last_result
from public.jobs j
where j.company_id is not null
  and j.last_result is not null
  and not exists (
    select 1 from public.job_signal_events e
    where e.job_id = j.id
  );

commit;
