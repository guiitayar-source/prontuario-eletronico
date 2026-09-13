-- Importações conservam a origem em um arquivo clínico separado das edições locais.
create table public.import_batches (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null references public.clinics(id),
 actor_id uuid not null references auth.users(id), source text not null check(char_length(source) between 2 and 80),
 format text not null check(format in ('lgpd','fhir-r4')), state text not null default 'preview' check(state in ('preview','committed','reverted','cancelled')),
 payload jsonb, result jsonb, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '1 hour',
 committed_at timestamptz, reverted_at timestamptz, unique(clinic_id,id)
);
create table public.import_patient_links (
 clinic_id uuid not null, source text not null, format text not null, source_id text not null check(char_length(source_id) between 1 and 180), patient_id text not null,
 primary key(clinic_id,source,format,source_id), foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create table public.import_records (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null, batch_id uuid not null, patient_id text not null,
 source text not null, format text not null, patient_source text not null, source_id text not null check(char_length(source_id) between 1 and 300),
 kind text not null check(kind in ('consultation','condition','medication','allergy','prescription','appointment','document')),
 title text not null check(char_length(title) between 1 and 500), text text not null check(char_length(text)<=100000),
 occurred_at text, source_created_at text, source_status text not null, fingerprint text not null,
 imported_at timestamptz not null default now(), withdrawn_at timestamptz,
 foreign key(clinic_id,batch_id) references public.import_batches(clinic_id,id),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create unique index import_source_once on public.import_records(clinic_id,source,format,patient_source,kind,source_id) where withdrawn_at is null;
create index import_history on public.import_records(clinic_id,patient_id,imported_at desc);
create index import_batches_recent on public.import_batches(clinic_id,created_at desc);
alter table public.import_batches enable row level security;
alter table public.import_patient_links enable row level security;
alter table public.import_records enable row level security;
revoke all on public.import_batches,public.import_patient_links,public.import_records from public,anon,authenticated;
grant select on public.import_batches,public.import_patient_links,public.import_records to authenticated;
create policy import_batches_medical on public.import_batches for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy import_links_medical on public.import_patient_links for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy import_records_medical on public.import_records for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create trigger import_record_audit after insert or update on public.import_records for each row execute function public.record_change();
create function public.import_name(s text) returns text language sql immutable set search_path=public,pg_temp as $$
 select regexp_replace(translate(lower(btrim(s)), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'),'\s+',' ','g');
$$;
create function public.import_candidates(c uuid,p jsonb) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from (
 select id,name,dob,cpf,version from public.patients
 where clinic_id=c and (
  (nullif(p->>'cpf','') is not null and regexp_replace(coalesce(cpf,''),'\D','','g')=p->>'cpf')
  or public.import_name(name)=public.import_name(p->>'name')
 ) order by name,id limit 101
 ) q;
$$;
revoke all on function public.import_candidates(uuid,jsonb) from public,anon,authenticated;
create function public.import_preview(c uuid,origin_name text,plan jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p jsonb; r jsonb; candidates jsonb; linked text; list jsonb:='[]'; records jsonb:='[]'; old public.import_records; batch uuid; normalized_source text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 normalized_source:=lower(btrim(origin_name));
 if char_length(normalized_source) not between 2 and 80 or plan->>'format' not in ('lgpd','fhir-r4') or jsonb_typeof(plan->'patients') is distinct from 'array' or jsonb_typeof(plan->'records') is distinct from 'array' or jsonb_array_length(plan->'patients') not between 1 and 30 or jsonb_array_length(plan->'records')>500 or octet_length(plan::text)>3000000 then raise exception 'Prévia inválida ou acima do limite.';end if;
 update public.import_batches set payload=null,state='cancelled' where clinic_id=c and state='preview' and expires_at<now();
 for p in select value from jsonb_array_elements(plan->'patients') loop
  candidates:=public.import_candidates(c,p->'fields');
  if jsonb_array_length(candidates)>100 then raise exception 'Muitos cadastros com o mesmo nome. Revise a identificação antes de importar.';end if;
  select patient_id into linked from public.import_patient_links where clinic_id=c and source=normalized_source and format=plan->>'format' and source_id=p->>'source_id';
  if linked is not null and not exists(select 1 from jsonb_array_elements(candidates) x where x->>'id'=linked) then
   candidates:=candidates||(select jsonb_build_array(jsonb_build_object('id',id,'name',name,'dob',dob,'cpf',cpf,'version',version)) from public.patients where clinic_id=c and id=linked);
  end if;
  list:=list||jsonb_build_array(p||jsonb_build_object('candidates',candidates,'linked_id',linked));
 end loop;
 for r in select value from jsonb_array_elements(plan->'records') loop
  select * into old from public.import_records where clinic_id=c and source=normalized_source and format=plan->>'format' and patient_source=r->>'patient_source' and kind=r->>'kind' and source_id=r->>'source_id' and withdrawn_at is null;
  records:=records||jsonb_build_array(r||jsonb_build_object('duplicate',found and old.fingerprint=encode(sha256(convert_to((r-'fingerprint')::text,'UTF8')),'hex'),'conflict',found and old.fingerprint<>encode(sha256(convert_to((r-'fingerprint')::text,'UTF8')),'hex')));
 end loop;
 plan:=plan||jsonb_build_object('patients',list,'records',records);
 insert into public.import_batches(clinic_id,actor_id,source,format,payload) values(c,auth.uid(),normalized_source,plan->>'format',plan) returning id into batch;
 return jsonb_build_object('id',batch,'source',normalized_source,'plan',plan);
end $$;
create function public.import_commit(c uuid,b uuid,choices jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
   insert into public.import_records(clinic_id,batch_id,patient_id,source,format,patient_source,source_id,kind,title,text,occurred_at,source_created_at,source_status,fingerprint)
   values(c,b,target,batch.source,batch.format,p->>'source_id',r->>'source_id',r->>'kind',r->>'title',r->>'text',r->>'occurred_at',r->>'source_created_at',coalesce(r->>'source_status',''),fingerprint_value);
   imported:=imported+1;
  end loop;
 end loop;
 if jsonb_array_length(patient_list)=0 then raise exception 'Selecione ao menos um paciente.';end if;
 output_result:=jsonb_build_object('id',b,'patients',patient_list,'created',created,'imported',imported,'skipped',skipped);
 update public.import_batches set state='committed',payload=null,committed_at=now(),result=output_result where id=b;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context) values(c,auth.uid(),'import_commit','import_batches',b::text,jsonb_build_object('imported',imported,'skipped',skipped,'created',created));
 return output_result;
end $$;
create function public.import_revert(c uuid,b uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare batch public.import_batches;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 perform pg_advisory_xact_lock(hashtextextended(c::text,731));
 select * into batch from public.import_batches where clinic_id=c and id=b for update;
 if not found or (batch.actor_id<>auth.uid() and not public.has_clinic_role(c,array['owner']::public.clinic_role[])) then raise insufficient_privilege;end if;
 if batch.state='reverted' then return;end if;
 if batch.state<>'committed' then raise exception 'Somente importações concluídas podem ser desfeitas.';end if;
 update public.import_records set withdrawn_at=now() where clinic_id=c and batch_id=b and withdrawn_at is null;
 update public.import_batches set state='reverted',reverted_at=now() where id=b;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id) values(c,auth.uid(),'import_revert','import_batches',b::text);
end $$;
create function public.import_cancel(c uuid,b uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 update public.import_batches set state='cancelled',payload=null where clinic_id=c and id=b and actor_id=auth.uid() and state='preview';
end $$;
revoke all on function public.import_preview(uuid,text,jsonb),public.import_commit(uuid,uuid,jsonb),public.import_revert(uuid,uuid),public.import_cancel(uuid,uuid) from public,anon;
grant execute on function public.import_preview(uuid,text,jsonb),public.import_commit(uuid,uuid,jsonb),public.import_revert(uuid,uuid),public.import_cancel(uuid,uuid) to authenticated;
