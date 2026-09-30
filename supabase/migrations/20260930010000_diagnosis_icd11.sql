-- Diagnósticos: código CID-11 opcional ao lado do CID-10 e vínculo de cada
-- diagnóstico às consultas em que foi considerado (com cópia do estado no atendimento).

alter table public.patient_conditions
 add column if not exists icd11_code text check(icd11_code is null or char_length(icd11_code)<=20),
 add column if not exists icd11_title text check(icd11_title is null or char_length(icd11_title)<=500),
 add column if not exists icd11_release text check(icd11_release is null or char_length(icd11_release)<=20);

create table public.consultation_diagnoses (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id),
 patient_id text not null,
 consultation_id uuid not null references public.consultations(id),
 condition_id uuid not null references public.patient_conditions(id),
 author_id uuid not null references auth.users(id),
 description text not null,
 cid_code text,
 icd11_code text,
 icd11_title text,
 icd11_release text,
 status text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(consultation_id,condition_id),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create index consultation_diagnoses_patient on public.consultation_diagnoses(clinic_id,patient_id,created_at);
alter table public.consultation_diagnoses enable row level security;
revoke all on public.consultation_diagnoses from anon,authenticated;
grant select on public.consultation_diagnoses to authenticated;
create policy consultation_diagnoses_medical_read on public.consultation_diagnoses for select to authenticated
 using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create trigger consultation_diagnoses_audit after insert or update or delete on public.consultation_diagnoses
 for each row execute function public.record_change();

-- Consulta editável segue a mesma regra de consultation_write.
create function public.consultation_is_open(c uuid,patient text,consultation uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.consultations
  where id=consultation and clinic_id=c and patient_id=patient and finalized_at is null and status<>'SIGNED');
$$;
revoke all on function public.consultation_is_open(uuid,text,uuid) from public,anon,authenticated;

-- Copia o estado atual do diagnóstico para a consulta (cria ou atualiza o vínculo).
create function public.consultation_diagnosis_snapshot(c uuid,consultation uuid,condition uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare x public.patient_conditions;
begin
 select * into x from public.patient_conditions where id=condition and clinic_id=c;
 if not found then raise exception 'Diagnóstico não encontrado.'; end if;
 if not public.consultation_is_open(c,x.patient_id,consultation) then
  raise exception 'Consulta finalizada; os diagnósticos do atendimento não podem ser alterados.';
 end if;
 insert into public.consultation_diagnoses(clinic_id,patient_id,consultation_id,condition_id,author_id,description,cid_code,icd11_code,icd11_title,icd11_release,status)
 values(c,x.patient_id,consultation,x.id,auth.uid(),x.description,x.cid_code,x.icd11_code,x.icd11_title,x.icd11_release,x.status)
 on conflict(consultation_id,condition_id) do update set
  description=excluded.description,cid_code=excluded.cid_code,icd11_code=excluded.icd11_code,
  icd11_title=excluded.icd11_title,icd11_release=excluded.icd11_release,status=excluded.status,updated_at=now();
end $$;
revoke all on function public.consultation_diagnosis_snapshot(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function public.clinical_context_write(c uuid,entity text,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare row_id uuid; result jsonb; link uuid;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 if entity<>'allergy_state' then
  row_id:=(d->>'id')::uuid;
  if (entity='condition' and exists(select 1 from public.patient_conditions where id=row_id and clinic_id<>c))
   or (entity='medication' and exists(select 1 from public.patient_medications where id=row_id and clinic_id<>c))
   or (entity='allergy' and exists(select 1 from public.patient_allergies where id=row_id and clinic_id<>c)) then raise insufficient_privilege;end if;
 end if;
 link:=nullif(d->>'consultation_id','')::uuid;
 if link is not null and (entity<>'condition' or not public.consultation_is_open(c,d->>'patient_id',link)) then
  raise exception 'Consulta finalizada; os diagnósticos do atendimento não podem ser alterados.';
 end if;
 result:=public.clinical_context_write_internal(c,entity,d);
 if entity='condition' then
  update public.patient_conditions set
   icd11_code=nullif(upper(btrim(d->>'icd11_code')),''),
   icd11_title=case when nullif(btrim(d->>'icd11_code'),'') is null then null else nullif(btrim(d->>'icd11_title'),'') end,
   icd11_release=case when nullif(btrim(d->>'icd11_code'),'') is null then null else nullif(btrim(d->>'icd11_release'),'') end
  where id=row_id and (icd11_code,icd11_title,icd11_release) is distinct from
   (nullif(upper(btrim(d->>'icd11_code')),''),
    case when nullif(btrim(d->>'icd11_code'),'') is null then null else nullif(btrim(d->>'icd11_title'),'') end,
    case when nullif(btrim(d->>'icd11_code'),'') is null then null else nullif(btrim(d->>'icd11_release'),'') end);
  -- Atualiza a cópia nas consultas ainda abertas que já citam este diagnóstico.
  perform public.consultation_diagnosis_snapshot(c,v.consultation_id,row_id)
   from public.consultation_diagnoses v join public.consultations k on k.id=v.consultation_id
   where v.condition_id=row_id and k.finalized_at is null and k.status<>'SIGNED';
  if link is not null then perform public.consultation_diagnosis_snapshot(c,link,row_id); end if;
  select to_jsonb(x.*) into result from public.patient_conditions x where id=row_id;
 end if;
 return result;
end $$;
revoke all on function public.clinical_context_write(uuid,text,jsonb) from public,anon;grant execute on function public.clinical_context_write(uuid,text,jsonb) to authenticated;

-- Vincula ou desvincula um diagnóstico já existente de uma consulta aberta.
create function public.consultation_diagnosis_link(c uuid,consultation uuid,condition uuid,linked boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare patient text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 select patient_id into patient from public.patient_conditions where id=condition and clinic_id=c;
 if not found then raise exception 'Diagnóstico não encontrado.'; end if;
 if not public.consultation_is_open(c,patient,consultation) then
  raise exception 'Consulta finalizada; os diagnósticos do atendimento não podem ser alterados.';
 end if;
 if linked then perform public.consultation_diagnosis_snapshot(c,consultation,condition);
 else delete from public.consultation_diagnoses where consultation_id=consultation and condition_id=condition and clinic_id=c;
 end if;
 return jsonb_build_object('consultation_id',consultation,'condition_id',condition,'linked',linked);
end $$;
revoke all on function public.consultation_diagnosis_link(uuid,uuid,uuid,boolean) from public,anon;
grant execute on function public.consultation_diagnosis_link(uuid,uuid,uuid,boolean) to authenticated;
