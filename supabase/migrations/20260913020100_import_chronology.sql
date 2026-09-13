alter table public.import_records add column occurred_sort timestamptz;
create index import_records_chronology on public.import_records(clinic_id,patient_id,occurred_sort desc) where withdrawn_at is null;
create or replace function public.import_commit(c uuid,b uuid,choices jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare batch public.import_batches; p jsonb; r jsonb; choice jsonb; target text; linked text; old public.import_records; fingerprint_value text; candidates jsonb; selected public.patients;
 imported integer:=0; skipped integer:=0; created integer:=0; patient_list jsonb:='[]'; output_result jsonb;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 perform pg_advisory_xact_lock(hashtextextended(c::text,731));
 select * into batch from public.import_batches where clinic_id=c and id=b and actor_id=auth.uid() for update;
 if not found then raise insufficient_privilege;end if;
 if batch.state='committed' then return batch.result;end if;
 if batch.state<>'preview' or batch.expires_at<now() then raise exception 'Prévia expirada ou cancelada. Gere uma nova prévia.';end if;
 if jsonb_typeof(choices) is distinct from 'array' or jsonb_array_length(choices)<>jsonb_array_length(batch.payload->'patients') then raise exception 'Revise o destino de todos os pacientes.';end if;
 for p in select value from jsonb_array_elements(batch.payload->'patients') loop
  if (select count(*) from jsonb_array_elements(choices) x where x->>'source_id'=p->>'source_id')<>1 then raise exception 'Seleção de pacientes inválida.';end if;
  select value into choice from jsonb_array_elements(choices) where value->>'source_id'=p->>'source_id';
  target:=choice->>'target';
  if target='skip' then continue;end if;
  if jsonb_array_length(coalesce(p->'errors','[]'))>0 then raise exception 'Paciente com identificação inválida. Corrija o arquivo ou ignore o paciente.';end if;
  select patient_id into linked from public.import_patient_links where clinic_id=c and source=batch.source and format=batch.format and source_id=p->>'source_id';
  if linked is not null and target is distinct from linked then raise exception 'A origem já está vinculada a outro destino. Gere uma nova prévia.';end if;
  candidates:=public.import_candidates(c,p->'fields');
  if target='new' then
   if jsonb_array_length(candidates)>0 then raise exception 'Possível paciente duplicado. Gere nova prévia e revise o cadastro existente.';end if;
   target:=gen_random_uuid()::text;
   insert into public.patients(clinic_id,id,name,social_name,dob,cpf,rg,gender,occupation,marital_status,schooling,nationality,phone,secondary_phone,email,preferred_contact,zip_code,street,address_number,complement,neighborhood,city,state,guardian_name,guardian_relationship,guardian_phone,emergency_name,emergency_relationship,emergency_phone,insurance,insurance_number,referral_source,admin_notes,search_text)
   values(c,target,p->'fields'->>'name',nullif(p->'fields'->>'social_name',''),nullif(p->'fields'->>'dob','')::date,nullif(p->'fields'->>'cpf',''),p->'fields'->>'rg',p->'fields'->>'gender',p->'fields'->>'occupation',p->'fields'->>'marital_status',p->'fields'->>'schooling',p->'fields'->>'nationality',p->'fields'->>'phone',p->'fields'->>'secondary_phone',p->'fields'->>'email',p->'fields'->>'preferred_contact',p->'fields'->>'zip_code',p->'fields'->>'street',p->'fields'->>'address_number',p->'fields'->>'complement',p->'fields'->>'neighborhood',p->'fields'->>'city',p->'fields'->>'state',p->'fields'->>'guardian_name',p->'fields'->>'guardian_relationship',p->'fields'->>'guardian_phone',p->'fields'->>'emergency_name',p->'fields'->>'emergency_relationship',p->'fields'->>'emergency_phone',p->'fields'->>'insurance',p->'fields'->>'insurance_number',p->'fields'->>'referral_source',p->'fields'->>'admin_notes',public.import_name(concat_ws(' ',p->'fields'->>'name',p->'fields'->>'social_name',p->'fields'->>'cpf',p->'fields'->>'phone',p->'fields'->>'email')));
   created:=created+1;
  else
   select * into selected from public.patients where clinic_id=c and id=target for update;
   if not found then raise insufficient_privilege;end if;
   if not exists(select 1 from jsonb_array_elements(p->'candidates') x where x->>'id'=target and (x->>'version')::integer=selected.version and x->>'name'=selected.name and coalesce(x->>'cpf','')=coalesce(selected.cpf,'') and coalesce(x->>'dob','')=coalesce(selected.dob::text,'')) then raise exception 'Cadastro alterado ou destino fora da prévia. Gere uma nova prévia.';end if;
   if nullif(p->'fields'->>'cpf','') is not null and nullif(selected.cpf,'') is not null and p->'fields'->>'cpf'<>regexp_replace(selected.cpf,'\D','','g') then raise exception 'CPF da origem difere do paciente escolhido. Revise a identificação.';end if;
  end if;
  if exists(select 1 from jsonb_array_elements(patient_list) x where x->>'id'=target) then raise exception 'Dois pacientes da origem apontam para o mesmo cadastro. Importe-os separadamente após revisão.';end if;
  insert into public.import_patient_links(clinic_id,source,format,source_id,patient_id) values(c,batch.source,batch.format,p->>'source_id',target) on conflict do nothing;
  patient_list:=patient_list||jsonb_build_array(jsonb_build_object('id',target,'name',p->'fields'->>'name'));
  for r in select value from jsonb_array_elements(batch.payload->'records') where value->>'patient_source'=p->>'source_id' loop
   fingerprint_value:=encode(sha256(convert_to((r-'fingerprint'-'duplicate'-'conflict')::text,'UTF8')),'hex');
   select * into old from public.import_records where clinic_id=c and source=batch.source and format=batch.format and patient_source=r->>'patient_source' and kind=r->>'kind' and source_id=r->>'source_id' and withdrawn_at is null;
   if found then
    if old.patient_id<>target or old.fingerprint<>fingerprint_value then raise exception 'Registro de origem já importado com conteúdo diferente. Nada foi gravado; revise o arquivo.';end if;
    skipped:=skipped+1;continue;
   end if;
   insert into public.import_records(clinic_id,batch_id,patient_id,source,format,patient_source,source_id,kind,title,text,occurred_at,source_created_at,source_status,fingerprint,occurred_sort)
   values(c,b,target,batch.source,batch.format,p->>'source_id',r->>'source_id',r->>'kind',r->>'title',r->>'text',r->>'occurred_at',r->>'source_created_at',coalesce(r->>'source_status',''),fingerprint_value,case when length(r->>'occurred_at')=10 then ((r->>'occurred_at')||'T00:00:00Z')::timestamptz else (r->>'occurred_at')::timestamptz end);
   imported:=imported+1;
  end loop;
 end loop;
 if jsonb_array_length(patient_list)=0 then raise exception 'Selecione ao menos um paciente.';end if;
 output_result:=jsonb_build_object('id',b,'patients',patient_list,'created',created,'imported',imported,'skipped',skipped);
 update public.import_batches set state='committed',payload=null,committed_at=now(),result=output_result where id=b;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context) values(c,auth.uid(),'import_commit','import_batches',b::text,jsonb_build_object('imported',imported,'skipped',skipped,'created',created));
 return output_result;
end $$;
