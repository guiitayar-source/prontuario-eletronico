create table public.patient_conditions (
 id uuid primary key, clinic_id uuid not null references public.clinics(id), patient_id text not null,
 author_id uuid not null references auth.users(id), description text not null check(char_length(btrim(description)) between 1 and 500),
 cid_code text check(cid_code is null or char_length(cid_code)<=20), status text not null check(status in ('hypothesis','confirmed','resolved')),
 notes text check(notes is null or char_length(notes)<=4000), version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create table public.patient_medications (
 id uuid primary key, clinic_id uuid not null references public.clinics(id), patient_id text not null,
 author_id uuid not null references auth.users(id), name text not null check(char_length(btrim(name)) between 1 and 300),
 dose text check(dose is null or char_length(dose)<=200), instructions text check(instructions is null or char_length(instructions)<=1000),
 status text not null check(status in ('active','stopped')), version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create table public.patient_allergies (
 id uuid primary key, clinic_id uuid not null references public.clinics(id), patient_id text not null,
 author_id uuid not null references auth.users(id), substance text not null check(char_length(btrim(substance)) between 1 and 300),
 reaction text check(reaction is null or char_length(reaction)<=1000), status text not null check(status in ('active','inactive')),
 version integer not null default 1 check(version>0), created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create table public.patient_allergy_states (
 clinic_id uuid not null references public.clinics(id), id text not null, author_id uuid not null references auth.users(id),
 state text not null check(state in ('unknown','none','known')),version integer not null default 1 check(version>0),updated_at timestamptz not null default now(),
 primary key(clinic_id,id),foreign key(clinic_id,id) references public.patients(clinic_id,id)
);
create index conditions_patient on public.patient_conditions(clinic_id,patient_id,updated_at desc);
create index medications_patient on public.patient_medications(clinic_id,patient_id,updated_at desc);
create index allergies_patient on public.patient_allergies(clinic_id,patient_id,updated_at desc);
alter table public.patient_conditions enable row level security;alter table public.patient_medications enable row level security;alter table public.patient_allergies enable row level security;alter table public.patient_allergy_states enable row level security;
revoke all on public.patient_conditions,public.patient_medications,public.patient_allergies,public.patient_allergy_states from anon,authenticated;
grant select on public.patient_conditions,public.patient_medications,public.patient_allergies,public.patient_allergy_states to authenticated;
create policy conditions_medical_read on public.patient_conditions for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy medications_medical_read on public.patient_medications for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy allergies_medical_read on public.patient_allergies for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy allergy_state_medical_read on public.patient_allergy_states for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));

create function public.clinical_context_write(c uuid,entity text,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; current_version integer; owner_patient text; row_id uuid; patient text; requested_version integer;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 patient:=d->>'patient_id'; requested_version:=(d->>'version')::integer;
 perform 1 from public.patients where clinic_id=c and id=patient for update;if not found then raise exception 'Paciente não encontrado.';end if;
 if entity='allergy_state' then
  select version into current_version from public.patient_allergy_states where clinic_id=c and id=patient for update;
  if found and current_version<>requested_version then raise exception 'Contexto alterado em outra janela. Recarregue os dados.';end if;
  if not found and requested_version<>0 then raise exception 'Contexto alterado em outra janela. Recarregue os dados.';end if;
  insert into public.patient_allergy_states(clinic_id,id,author_id,state) values(c,patient,auth.uid(),d->>'state')
  on conflict(clinic_id,id) do update set state=excluded.state,author_id=auth.uid(),version=public.patient_allergy_states.version+1,updated_at=now()
  returning to_jsonb(patient_allergy_states.*) into result;
  if d->>'state'='none' then update public.patient_allergies set status='inactive',version=version+1,updated_at=now() where clinic_id=c and patient_id=patient and status='active';end if;
  return result;
 end if;
 row_id:=(d->>'id')::uuid;
 if entity='condition' then
  select version,patient_id into current_version,owner_patient from public.patient_conditions where id=row_id for update;
  if found then if owner_patient<>patient or current_version<>requested_version then raise exception 'Registro alterado em outra janela. Recarregue os dados.';end if;
   update public.patient_conditions set description=btrim(d->>'description'),cid_code=nullif(upper(btrim(d->>'cid_code')),''),status=d->>'status',notes=nullif(btrim(d->>'notes'),''),version=version+1,updated_at=now() where id=row_id returning to_jsonb(patient_conditions.*) into result;
  else if requested_version<>0 then raise exception 'Registro não encontrado.';end if;
   insert into public.patient_conditions(id,clinic_id,patient_id,author_id,description,cid_code,status,notes) values(row_id,c,patient,auth.uid(),btrim(d->>'description'),nullif(upper(btrim(d->>'cid_code')),''),d->>'status',nullif(btrim(d->>'notes'),'')) returning to_jsonb(patient_conditions.*) into result;end if;
 elsif entity='medication' then
  select version,patient_id into current_version,owner_patient from public.patient_medications where id=row_id for update;
  if found then if owner_patient<>patient or current_version<>requested_version then raise exception 'Registro alterado em outra janela. Recarregue os dados.';end if;
   update public.patient_medications set name=btrim(d->>'name'),dose=nullif(btrim(d->>'dose'),''),instructions=nullif(btrim(d->>'instructions'),''),status=d->>'status',version=version+1,updated_at=now() where id=row_id returning to_jsonb(patient_medications.*) into result;
  else if requested_version<>0 then raise exception 'Registro não encontrado.';end if;
   insert into public.patient_medications(id,clinic_id,patient_id,author_id,name,dose,instructions,status) values(row_id,c,patient,auth.uid(),btrim(d->>'name'),nullif(btrim(d->>'dose'),''),nullif(btrim(d->>'instructions'),''),d->>'status') returning to_jsonb(patient_medications.*) into result;end if;
 elsif entity='allergy' then
  select version,patient_id into current_version,owner_patient from public.patient_allergies where id=row_id for update;
  if found then if owner_patient<>patient or current_version<>requested_version then raise exception 'Registro alterado em outra janela. Recarregue os dados.';end if;
   update public.patient_allergies set substance=btrim(d->>'substance'),reaction=nullif(btrim(d->>'reaction'),''),status=d->>'status',version=version+1,updated_at=now() where id=row_id returning to_jsonb(patient_allergies.*) into result;
  else if requested_version<>0 then raise exception 'Registro não encontrado.';end if;
   insert into public.patient_allergies(id,clinic_id,patient_id,author_id,substance,reaction,status) values(row_id,c,patient,auth.uid(),btrim(d->>'substance'),nullif(btrim(d->>'reaction'),''),d->>'status') returning to_jsonb(patient_allergies.*) into result;end if;
 else raise exception 'Tipo de registro inválido.';end if;
 return result;
end $$;
revoke all on function public.clinical_context_write(uuid,text,jsonb) from public,anon;grant execute on function public.clinical_context_write(uuid,text,jsonb) to authenticated;
create trigger conditions_audit after insert or update on public.patient_conditions for each row execute function public.record_change();
create trigger medications_audit after insert or update on public.patient_medications for each row execute function public.record_change();
create trigger allergies_audit after insert or update on public.patient_allergies for each row execute function public.record_change();
create trigger allergy_states_audit after insert or update on public.patient_allergy_states for each row execute function public.record_change();
