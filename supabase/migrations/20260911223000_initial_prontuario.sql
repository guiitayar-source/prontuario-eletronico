create extension if not exists pgcrypto;

create type public.clinic_role as enum ('owner', 'doctor', 'secretary');
create type public.appointment_modality as enum ('presencial', 'teleconsulta');
create type public.appointment_status as enum (
  'scheduled', 'in_progress', 'completed', 'cancelled', 'no_show'
);
create type public.capture_state as enum ('pending', 'completed', 'revoked');
create type public.attachment_category as enum ('pending', 'exam', 'report', 'other');

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clinic_members (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.clinic_role not null,
  created_at timestamptz not null default now(),
  primary key (clinic_id, user_id)
);

create or replace function public.is_clinic_member(target_clinic_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.clinic_members
    where clinic_id = target_clinic_id and user_id = auth.uid()
  );
$$;

create or replace function public.has_clinic_role(
  target_clinic_id uuid,
  allowed_roles public.clinic_role[]
)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.clinic_members
    where clinic_id = target_clinic_id
      and user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

create or replace function public.create_clinic(clinic_name text)
returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  new_clinic_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if char_length(btrim(clinic_name)) not between 2 and 120 then
    raise exception 'Invalid clinic name';
  end if;
  insert into public.clinics (name)
  values (btrim(clinic_name)) returning id into new_clinic_id;
  insert into public.clinic_members (clinic_id, user_id, role)
  values (new_clinic_id, auth.uid(), 'owner');
  return new_clinic_id;
end;
$$;

revoke all on function public.is_clinic_member(uuid) from public;
revoke all on function public.has_clinic_role(uuid, public.clinic_role[]) from public;
revoke all on function public.create_clinic(text) from public;
grant execute on function public.is_clinic_member(uuid) to authenticated;
grant execute on function public.has_clinic_role(uuid, public.clinic_role[]) to authenticated;
grant execute on function public.create_clinic(text) to authenticated;

create table public.patients (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  id text not null,
  name text not null check (char_length(btrim(name)) between 2 and 180),
  social_name text, dob date, cpf text, rg text, gender text,
  occupation text, marital_status text, schooling text, nationality text,
  phone text, secondary_phone text, email text, preferred_contact text,
  zip_code text, street text, address_number text, complement text,
  neighborhood text, city text, state text,
  guardian_name text, guardian_relationship text, guardian_phone text,
  emergency_name text, emergency_relationship text, emergency_phone text,
  insurance text, insurance_number text, referral_source text,
  admin_notes text,
  search_text text not null default '',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, id)
);

create unique index patients_clinic_cpf_unique
  on public.patients (clinic_id, cpf)
  where cpf is not null and btrim(cpf) <> '';
create index patients_clinic_name_idx on public.patients (clinic_id, name);
create index patients_search_idx
  on public.patients using gin (to_tsvector('simple', search_text));

create table public.appointments (
  clinic_id uuid not null,
  id text not null,
  patient_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  modality public.appointment_modality not null default 'presencial',
  status public.appointment_status not null default 'scheduled',
  admin_notes text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, id),
  foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  check (ends_at > starts_at),
  check (ends_at - starts_at between interval '10 minutes' and interval '8 hours')
);

create index appointments_clinic_starts_idx
  on public.appointments (clinic_id, starts_at);
create index appointments_patient_starts_idx
  on public.appointments (clinic_id, patient_id, starts_at);

create table public.device_sessions (
  id text primary key,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  unique (clinic_id, id)
);

create index device_sessions_clinic_idx on public.device_sessions (clinic_id);

create table public.capture_requests (
  id text primary key,
  clinic_id uuid not null,
  session_id text not null,
  patient_id text not null,
  patient_name text not null,
  category text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state public.capture_state not null default 'pending',
  foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  foreign key (clinic_id, session_id)
    references public.device_sessions(clinic_id, id) on delete cascade,
  unique (clinic_id, id)
);

create index capture_requests_session_idx
  on public.capture_requests (session_id, created_at);

create table public.attachments (
  id text primary key,
  clinic_id uuid not null,
  request_id text not null,
  patient_id text not null,
  name text not null,
  mime text not null,
  size bigint not null check (size between 1 and 12582912),
  storage_path text not null unique,
  category public.attachment_category not null default 'pending',
  created_at timestamptz not null default now(),
  foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  foreign key (clinic_id, request_id)
    references public.capture_requests(clinic_id, id) on delete cascade
);

create index attachments_clinic_patient_idx
  on public.attachments (clinic_id, patient_id);
create index attachments_request_idx on public.attachments (request_id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(action) between 2 and 80),
  entity_type text not null check (char_length(entity_type) between 2 and 80),
  entity_id text not null check (char_length(entity_id) between 1 and 180),
  occurred_at timestamptz not null default now(),
  context jsonb not null default '{}'::jsonb
);

create index audit_events_clinic_time_idx
  on public.audit_events (clinic_id, occurred_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger clinics_set_updated_at before update on public.clinics
for each row execute function public.set_updated_at();
create trigger patients_set_updated_at before update on public.patients
for each row execute function public.set_updated_at();
create trigger appointments_set_updated_at before update on public.appointments
for each row execute function public.set_updated_at();

alter table public.clinics enable row level security;
alter table public.clinic_members enable row level security;
alter table public.patients enable row level security;
alter table public.appointments enable row level security;
alter table public.device_sessions enable row level security;
alter table public.capture_requests enable row level security;
alter table public.attachments enable row level security;
alter table public.audit_events enable row level security;

create policy clinics_read_members on public.clinics for select to authenticated
using (public.is_clinic_member(id));
create policy clinics_update_owners on public.clinics for update to authenticated
using (public.has_clinic_role(id, array['owner']::public.clinic_role[]))
with check (public.has_clinic_role(id, array['owner']::public.clinic_role[]));

create policy clinic_members_read_members on public.clinic_members
for select to authenticated using (public.is_clinic_member(clinic_id));
create policy clinic_members_manage_owners on public.clinic_members
for all to authenticated
using (public.has_clinic_role(clinic_id, array['owner']::public.clinic_role[]))
with check (public.has_clinic_role(clinic_id, array['owner']::public.clinic_role[]));

create policy patients_read_members on public.patients for select to authenticated
using (public.is_clinic_member(clinic_id));
create policy patients_write_members on public.patients for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));
create policy appointments_read_members on public.appointments for select to authenticated
using (public.is_clinic_member(clinic_id));
create policy appointments_write_members on public.appointments for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));
create policy device_sessions_members on public.device_sessions for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));
create policy capture_requests_members on public.capture_requests for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));
create policy attachments_members on public.attachments for all to authenticated
using (public.is_clinic_member(clinic_id))
with check (public.is_clinic_member(clinic_id));

create policy audit_events_read_clinicians on public.audit_events
for select to authenticated
using (public.has_clinic_role(
  clinic_id, array['owner', 'doctor']::public.clinic_role[]
));
create policy audit_events_insert_members on public.audit_events
for insert to authenticated
with check (actor_id = auth.uid() and public.is_clinic_member(clinic_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'clinical-files', 'clinical-files', false, 12582912,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_access_clinical_object(object_name text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.clinic_members
    where clinic_id::text = split_part(object_name, '/', 1)
      and user_id = auth.uid()
  );
$$;

revoke all on function public.can_access_clinical_object(text) from public;
grant execute on function public.can_access_clinical_object(text) to authenticated;

create policy clinical_files_read_members on storage.objects for select to authenticated
using (bucket_id = 'clinical-files' and public.can_access_clinical_object(name));
create policy clinical_files_insert_members on storage.objects for insert to authenticated
with check (bucket_id = 'clinical-files' and public.can_access_clinical_object(name));
create policy clinical_files_update_members on storage.objects for update to authenticated
using (bucket_id = 'clinical-files' and public.can_access_clinical_object(name))
with check (bucket_id = 'clinical-files' and public.can_access_clinical_object(name));
create policy clinical_files_delete_members on storage.objects for delete to authenticated
using (bucket_id = 'clinical-files' and public.can_access_clinical_object(name));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.clinics to authenticated;
grant select, insert, update, delete on public.clinic_members to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;
grant select, insert, update, delete on public.device_sessions to authenticated;
grant select, insert, update, delete on public.capture_requests to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;
grant select, insert on public.audit_events to authenticated;
grant usage, select on sequence public.audit_events_id_seq to authenticated;
