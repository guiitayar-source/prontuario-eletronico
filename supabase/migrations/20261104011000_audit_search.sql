-- Vincula eventos ao paciente sem incluir texto clínico na auditoria.
alter table public.audit_events add column patient_id text;
create index audit_events_clinic_cursor_idx on public.audit_events(clinic_id,id desc);
create index audit_events_patient_cursor_idx on public.audit_events(clinic_id,patient_id,id desc);

create function public.audit_patient(c uuid,entity text,entity_key text) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare patient text;
begin
 if entity in ('patients','patient_allergy_states','patient_medication_states') then return entity_key; end if;
 if entity in ('consultations','clinical_documents','patient_conditions','patient_medications','patient_allergies','appointments','attachments','exam_results','import_records','consultation_diagnoses') then
  execute format('select patient_id from public.%I where clinic_id=$1 and id::text=$2',entity) into patient using c,entity_key;
 elsif entity='consultation_addenda' then
  select k.patient_id into patient from public.consultation_addenda a join public.consultations k on k.id=a.consultation_id and k.clinic_id=a.clinic_id where a.clinic_id=c and a.id::text=entity_key;
 end if;
 return patient;
end $$;
revoke all on function public.audit_patient(uuid,text,text) from public,anon,authenticated;

create function public.audit_patient_link() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.patient_id is null then new.patient_id:=public.audit_patient(new.clinic_id,new.entity_type,new.entity_id); end if;
 return new;
end $$;
revoke all on function public.audit_patient_link() from public;
create trigger audit_patient_link before insert on public.audit_events for each row execute function public.audit_patient_link();

create or replace function public.record_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb; patient text;
begin
 row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 patient:=case when tg_table_name in ('patients','patient_allergy_states','patient_medication_states') then row_data->>'id' else row_data->>'patient_id' end;
 if auth.uid() is not null then
  insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,patient_id)
  values((row_data->>'clinic_id')::uuid,auth.uid(),lower(tg_op),tg_table_name,row_data->>'id',patient);
 end if;
 return coalesce(new,old);
end $$;
revoke all on function public.record_change() from public;
-- Somente o novo vínculo é preenchido. Eventos de entidades já removidas podem permanecer sem vínculo.
update public.audit_events set patient_id=public.audit_patient(clinic_id,entity_type,entity_id) where patient_id is null;

create function public.audit_search(c uuid, before_id bigint default null, from_at timestamptz default null,
 to_at timestamptz default null, actor uuid default null, patient text default null,
 operation text default null, category text default 'all', search text default null)
returns table(id text,actor_id uuid,action text,entity_type text,entity_id text,occurred_at timestamptz,patient_id text,clinic_id uuid) language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 if category not in ('all','imports','clinical','security') then raise exception 'Categoria inválida.'; end if;
 return query select a.id::text,a.actor_id,a.action,a.entity_type,a.entity_id,a.occurred_at,a.patient_id,a.clinic_id from public.audit_events a
 where a.clinic_id=c
 and (before_id is null or a.id<before_id)
 and (from_at is null or a.occurred_at>=from_at) and (to_at is null or a.occurred_at<to_at)
 and (actor is null or a.actor_id=actor)
 and (patient is null or a.patient_id=patient or exists(select 1 from public.patients p where p.clinic_id=c and p.id=a.patient_id and (strpos(lower(p.name),lower(patient))>0 or strpos(lower(coalesce(p.social_name,'')),lower(patient))>0)))
 and (operation is null or a.action=operation)
 and (search is null or strpos(lower(concat_ws(' ',a.action,a.entity_type,a.entity_id,a.actor_id::text)),lower(search))>0)
 and (category='all'
  or (category='imports' and (a.action like '%import%' or a.action like '%export%' or a.entity_type like '%import%'))
  or (category='clinical' and a.entity_type in ('patients','consultations','consultation_addenda','clinical_documents','clinical_context','patient_conditions','patient_medications','patient_medication_states','patient_allergies','patient_allergy_states','consultation_diagnoses','exam_results','exam_definitions'))
  or (category='security' and (a.action like '%mfa%' or a.action like '%invite%' or a.action like '%role%' or a.action like '%revoke%' or a.entity_type in ('clinics','clinic_members'))))
 order by a.id desc limit 101;
end $$;
revoke all on function public.audit_search(uuid,bigint,timestamptz,timestamptz,uuid,text,text,text,text) from public,anon;
grant execute on function public.audit_search(uuid,bigint,timestamptz,timestamptz,uuid,text,text,text,text) to authenticated;
