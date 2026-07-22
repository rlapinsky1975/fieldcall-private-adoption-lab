-- Private adoption lab: assessment-level Shadow Mode and immutable records.
begin;

alter table public.jobs
  add column if not exists shadow_mode_enabled boolean not null default false;

create or replace function public.prevent_fieldcall_record_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This FieldCall record is locked after it is saved.';
end;
$$;

drop trigger if exists lock_contractor_decisions_after_insert on public.contractor_decisions;
create trigger lock_contractor_decisions_after_insert
before update on public.contractor_decisions
for each row execute function public.prevent_fieldcall_record_update();

drop trigger if exists lock_job_outcomes_after_insert on public.job_outcomes;
create trigger lock_job_outcomes_after_insert
before update on public.job_outcomes
for each row execute function public.prevent_fieldcall_record_update();

commit;
