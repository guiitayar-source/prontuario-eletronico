-- Audio never enters this table. Native clients receive a capability for one
-- consultation, not a Supabase session or access to the clinical record.
create table public.anamnesator_requests (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id),
 patient_id text not null,
 consultation_id uuid not null references public.consultations(id),
 requested_by uuid not null references auth.users(id),
 patient_label text not null,
 source text not null default 'android' check(source in ('android','desktop')),
 pair_hash text not null check (pair_hash ~ '^[a-f0-9]{64}$'),
 device_hash text check (device_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'waiting' check (state in ('waiting','linked','received','cancelled')),
 created_at timestamptz not null default now(),
 pair_expires_at timestamptz not null default now() + interval '10 minutes',
 device_expires_at timestamptz,
 transcription text not null default '' check (char_length(transcription) <= 100000),
 draft text not null default '' check (char_length(draft) <= 100000),
 revision integer not null default 0 check (revision >= 0),
 received_at timestamptz,
 foreign key (clinic_id,patient_id) references public.patients(clinic_id,id)
);
create index anamnesator_consultation on public.anamnesator_requests(clinic_id,consultation_id,created_at desc);
alter table public.anamnesator_requests enable row level security;
revoke all on public.anamnesator_requests from anon,authenticated;
-- Column grants prevent even authenticated direct queries from reading hashes.
grant select(id,clinic_id,patient_id,consultation_id,requested_by,patient_label,source,state,
 created_at,pair_expires_at,device_expires_at,transcription,draft,revision,received_at)
 on public.anamnesator_requests to authenticated;
create policy anamnesator_read on public.anamnesator_requests for select to authenticated
 using (public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));

create function public.anamnesator_request(c uuid, action text, d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.anamnesator_requests; visit public.consultations; label text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
  raise insufficient_privilege;
 end if;
 if action='create' then
  select * into visit from public.consultations where clinic_id=c and id=(d->>'consultation_id')::uuid for update;
  if not found or visit.author_id<>auth.uid() or visit.finalized_at is not null then raise insufficient_privilege; end if;
  if d->>'pair_hash' is null or d->>'pair_hash' !~ '^[a-f0-9]{64}$' then raise invalid_parameter_value; end if;
  -- A new pairing revokes earlier waiting/active capabilities for this visit.
  update public.anamnesator_requests set state='cancelled',device_hash=null
   where consultation_id=visit.id and source='android' and state in ('waiting','linked','received');
  select coalesce(nullif(name,''),'Paciente') into label from public.patients where clinic_id=c and id=visit.patient_id;
  insert into public.anamnesator_requests(id,clinic_id,patient_id,consultation_id,requested_by,patient_label,pair_hash)
   values((d->>'id')::uuid,c,visit.patient_id,visit.id,auth.uid(),label,d->>'pair_hash') returning * into r;
 elsif action='desktop_result' then
  select * into visit from public.consultations where clinic_id=c and id=(d->>'consultation_id')::uuid for update;
  if not found or visit.author_id<>auth.uid() then raise insufficient_privilege; end if;
  if char_length(btrim(coalesce(d->>'transcription','')))=0 or char_length(d->>'transcription')>100000
   or char_length(coalesce(d->>'draft',''))>100000 or (d->>'revision')::integer<1 then raise invalid_parameter_value; end if;
  select * into r from public.anamnesator_requests where id=(d->>'id')::uuid for update;
  if found then
   if r.clinic_id<>c or r.consultation_id<>visit.id or r.requested_by<>auth.uid() or r.source<>'desktop' then raise insufficient_privilege; end if;
   if (d->>'revision')::integer=r.revision and (r.transcription is distinct from d->>'transcription' or r.draft is distinct from coalesce(d->>'draft','')) then
    raise exception 'Revisão já recebida com outro conteúdo.';
   end if;
   if (d->>'revision')::integer>r.revision then
    update public.anamnesator_requests set transcription=d->>'transcription',draft=coalesce(d->>'draft',''),
     revision=(d->>'revision')::integer,received_at=now() where id=r.id returning * into r;
   end if;
  else
   select coalesce(nullif(name,''),'Paciente') into label from public.patients where clinic_id=c and id=visit.patient_id;
   insert into public.anamnesator_requests(id,clinic_id,patient_id,consultation_id,requested_by,patient_label,source,pair_hash,state,transcription,draft,revision,received_at)
    values((d->>'id')::uuid,c,visit.patient_id,visit.id,auth.uid(),label,'desktop',repeat('0',64),'received',
     d->>'transcription',coalesce(d->>'draft',''),(d->>'revision')::integer,now()) returning * into r;
  end if;
 elsif action='cancel' then
  update public.anamnesator_requests set state='cancelled',device_hash=null
   where id=(d->>'id')::uuid and clinic_id=c and requested_by=auth.uid() returning * into r;
  if not found then raise insufficient_privilege; end if;
 else raise invalid_parameter_value;
 end if;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
  values(r.clinic_id,auth.uid(),'anamnesator_'||action,'anamnesator_requests',r.id::text);
 return jsonb_build_object('id',r.id,'state',r.state,'pair_expires_at',r.pair_expires_at);
end $$;
revoke all on function public.anamnesator_request(uuid,text,jsonb) from public,anon;
grant execute on function public.anamnesator_request(uuid,text,jsonb) to authenticated;

-- These two functions are server-only. Raw capabilities are hashed by the HTTP
-- endpoint before reaching PostgreSQL; they are never part of browser listings.
create function public.anamnesator_native_claim(request_id uuid, pair_hash text, device_hash text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.anamnesator_requests;
begin
 select * into r from public.anamnesator_requests where id=request_id for update;
 if not found or r.source<>'android' or r.pair_hash is distinct from pair_hash or device_hash is null or device_hash !~ '^[a-f0-9]{64}$'
  or r.state='cancelled' then raise insufficient_privilege; end if;
 if not exists(select 1 from public.clinic_members where clinic_id=r.clinic_id and user_id=r.requested_by and role in ('owner','doctor')) then raise insufficient_privilege; end if;
 if r.state='waiting' and r.pair_expires_at>now() then
  update public.anamnesator_requests set state='linked',device_hash=anamnesator_native_claim.device_hash,
   device_expires_at=now()+interval '8 hours' where id=r.id returning * into r;
  insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
   values(r.clinic_id,r.requested_by,'anamnesator_claim','anamnesator_requests',r.id::text);
 elsif r.device_hash is distinct from device_hash or r.device_expires_at<=now() then
  raise insufficient_privilege;
 end if;
 -- Repeating the same claim after a lost HTTP response is safe.
 return jsonb_build_object('id',r.id,'consultation_id',r.consultation_id,'patient_label',r.patient_label,'expires_at',r.device_expires_at);
end $$;
revoke all on function public.anamnesator_native_claim(uuid,text,text) from public,anon,authenticated;
grant execute on function public.anamnesator_native_claim(uuid,text,text) to service_role;

create function public.anamnesator_native_result(request_id uuid, device_hash text, d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.anamnesator_requests; v integer; transcript text; generated text;
begin
 select * into r from public.anamnesator_requests where id=request_id for update;
 if not found or r.device_hash is distinct from device_hash or r.device_hash is null
  or r.device_expires_at<=now() or r.state not in ('linked','received') then raise insufficient_privilege; end if;
 if not exists(select 1 from public.clinic_members where clinic_id=r.clinic_id and user_id=r.requested_by and role in ('owner','doctor')) then raise insufficient_privilege; end if;
 if exists(select 1 from jsonb_object_keys(d) k where k not in ('revision','transcription','draft'))
  or jsonb_typeof(d->'transcription') is distinct from 'string'
  or jsonb_typeof(d->'draft') is distinct from 'string' then raise invalid_parameter_value; end if;
 v := (d->>'revision')::integer;
 transcript:=d->>'transcription'; generated:=d->>'draft';
 if v is null or v<1 or char_length(btrim(transcript))=0
  or char_length(transcript)>100000 or char_length(generated)>100000 then raise invalid_parameter_value; end if;
 if v=r.revision and (transcript is distinct from r.transcription or generated is distinct from r.draft) then
  raise exception 'Revisão já recebida com outro conteúdo.';
 end if;
 if v>r.revision then
  update public.anamnesator_requests set transcription=transcript,draft=generated,revision=v,
   received_at=now(),state='received' where id=r.id returning * into r;
  insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
   values(r.clinic_id,r.requested_by,'anamnesator_result','anamnesator_requests',r.id::text);
 end if;
 return jsonb_build_object('received',true,'revision',r.revision);
end $$;
revoke all on function public.anamnesator_native_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.anamnesator_native_result(uuid,text,jsonb) to service_role;
