-- Local development of RCE issuance. Only hmg is allowed in this release.
alter table public.clinical_documents add column rce_fields jsonb
  check(rce_fields is null or (jsonb_typeof(rce_fields)='object' and octet_length(rce_fields::text)<=20000));
alter table public.sncr_numbering_items drop constraint sncr_numbering_items_state_check;
alter table public.sncr_numbering_items add constraint sncr_numbering_items_state_check check(state in ('QUARANTINED','RESERVED','USED','VOID'));
alter table public.sncr_numbering_requests drop constraint sncr_numbering_requests_state_check;
alter table public.sncr_numbering_requests add constraint sncr_numbering_requests_state_check check(state in
 ('AUTH_PENDING','AUTH_EXPIRED','REQUESTING','AUTH_FAILED','REJECTED','UNKNOWN','RECEIVED_UNVERIFIED','CONTRACT_REVIEW','ALLOCATED'));

create table public.sncr_rce_emissions (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id),
  user_id uuid not null references auth.users(id),
  document_id uuid not null references public.clinical_documents(id),
  document_version integer not null,
  environment text not null check(environment='hmg'),
  number text not null,
  number_request_id uuid not null references public.sncr_numbering_requests(id),
  snapshot jsonb not null,
  snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
  state text not null default 'AWAITING_REVIEW' check(state in
    ('AWAITING_REVIEW','PREPARING','SIGNING','SIGNATURE_UNCERTAIN','FINALIZING','SIGNED','BLOCKED','CANCELLED')),
  attempt_id uuid,
  prepared_meta jsonb,
  signed_pdf_path text,
  signed_pdf_hash text,
  signed_at timestamptz,
  verification jsonb,
  number_checked_at timestamptz,
  number_checked_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(environment,number) references public.sncr_numbering_items(environment,number),
  unique(environment,number)
);
create unique index sncr_rce_document_active on public.sncr_rce_emissions(document_id) where state<>'CANCELLED';
create table public.sncr_rce_events (
  id bigint generated always as identity primary key,
  emission_id uuid not null references public.sncr_rce_emissions(id),
  clinic_id uuid not null,
  actor_id uuid not null,
  state text not null,
  attempt_id uuid,
  action text not null default 'STATE_CHANGED',
  created_at timestamptz not null default now()
);
alter table public.sncr_rce_emissions enable row level security;
alter table public.sncr_rce_events enable row level security;
revoke all on public.sncr_rce_emissions,public.sncr_rce_events from public,anon,authenticated,service_role;
grant select,insert,update on public.sncr_rce_emissions to service_role;
grant select on public.sncr_rce_events to service_role;
create function public.sncr_rce_audit() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.sncr_rce_events(emission_id,clinic_id,actor_id,state,attempt_id)
 values(new.id,new.clinic_id,new.user_id,new.state,new.attempt_id);
 return new;
end $$;
revoke all on function public.sncr_rce_audit() from public,anon,authenticated,service_role;
create trigger sncr_rce_audit after insert or update on public.sncr_rce_emissions for each row execute function public.sncr_rce_audit();
create function public.sncr_rce_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.snapshot is distinct from old.snapshot or new.snapshot_hash<>old.snapshot_hash or new.number<>old.number or
    new.environment<>old.environment or new.clinic_id<>old.clinic_id or new.user_id<>old.user_id or
    new.document_id<>old.document_id or new.document_version<>old.document_version or new.number_request_id<>old.number_request_id then
  raise exception 'O conteúdo e a numeração reservados são imutáveis.';
 end if;
 if old.state='SIGNED' and new is distinct from old then raise exception 'O original assinado e seus metadados são imutáveis.'; end if;
 return new;
end $$;
create trigger sncr_rce_immutable before update on public.sncr_rce_emissions for each row execute function public.sncr_rce_immutable();

create function public.sncr_rce_reserve(eid uuid,c uuid,u uuid,did uuid,v integer,s jsonb,h text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; e public.sncr_rce_emissions; n public.sncr_numbering_items; rid uuid;
begin
 select * into d from public.clinical_documents where id=did and clinic_id=c and author_id=u for update;
 if not found then raise insufficient_privilege; end if;
 select * into e from public.sncr_rce_emissions where id=eid;
 if found then
  if e.clinic_id<>c or e.user_id<>u or e.document_id<>did or e.snapshot_hash<>h then raise insufficient_privilege; end if;
  return to_jsonb(e);
 end if;
 if d.kind<>'Receita' or coalesce(d.prescription_category,'RCE')<>'RCE' or d.status not in ('DRAFT','SIGNATURE_FAILED') or d.version<>v then
  raise exception 'A receita foi alterada ou já está em emissão. Reabra antes de continuar.';
 end if;
 if exists(select 1 from public.sncr_rce_emissions where document_id=did and state<>'CANCELLED') then raise exception 'Já existe uma emissão para esta receita.'; end if;
 select i.* into n from public.sncr_numbering_items i join public.sncr_numbering_requests r on r.id=i.request_id
 where i.clinic_id=c and i.user_id=u and i.environment='hmg' and i.state='QUARANTINED'
 and r.category='RCE' and r.state='RECEIVED_UNVERIFIED' and r.input->>'conselho'='CRM'
 and r.input->>'documento'=s#>>'{prescriber,crm}' and r.input->>'uf'=s#>>'{prescriber,uf}'
 order by i.number limit 1 for update of i skip locked;
 if not found then raise exception 'Sem numeração RCE de teste disponível para seu CRM/UF. Conecte o SNCR e solicite um lote de homologação.'; end if;
 update public.sncr_numbering_items set state='RESERVED' where environment=n.environment and number=n.number;
 if not exists(select 1 from public.sncr_numbering_items where request_id=n.request_id and state='QUARANTINED') then
  update public.sncr_numbering_requests set state='ALLOCATED',updated_at=now() where id=n.request_id;
 end if;
 insert into public.sncr_rce_emissions(id,clinic_id,user_id,document_id,document_version,environment,number,number_request_id,snapshot,snapshot_hash)
 values(eid,c,u,did,v,'hmg',n.number,n.request_id,s,h) returning * into e;
 return to_jsonb(e);
end $$;

create function public.sncr_rce_acquire(eid uuid,c uuid,u uuid,h text,checked boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u for update;
 if not found then raise insufficient_privilege; end if;
 if e.snapshot_hash<>h or checked is distinct from true then raise exception 'Revise a receita e confira o vínculo do número no SNCR antes de assinar.'; end if;
 if e.state='AWAITING_REVIEW' or (e.state='PREPARING' and e.updated_at<now()-interval '2 minutes') then
  update public.sncr_rce_emissions set state='PREPARING',attempt_id=gen_random_uuid(),prepared_meta=null,
    number_checked_at=now(),number_checked_by=u,updated_at=now() where id=eid returning * into e;
  return jsonb_build_object('claimed',true,'emission',to_jsonb(e));
 end if;
 return jsonb_build_object('claimed',false,'emission',to_jsonb(e));
end $$;

create function public.sncr_rce_transition(eid uuid,c uuid,u uuid,a uuid,expected text,next_state text,meta jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u for update;
 if not found then raise insufficient_privilege; end if;
 if e.attempt_id is distinct from a or e.state<>expected then raise exception 'A emissão foi atualizada. Consulte o resultado antes de repetir.'; end if;
 if (expected,next_state) not in (('PREPARING','SIGNING'),('PREPARING','AWAITING_REVIEW'),
   ('SIGNING','SIGNATURE_UNCERTAIN'),('SIGNING','FINALIZING'),('SIGNATURE_UNCERTAIN','FINALIZING'),
   ('FINALIZING','BLOCKED')) then raise exception 'Transição de emissão inválida.'; end if;
 update public.sncr_rce_emissions set state=next_state,prepared_meta=coalesce(meta,prepared_meta),updated_at=now() where id=eid returning * into e;
 return to_jsonb(e);
end $$;

create function public.sncr_rce_finish(eid uuid,c uuid,u uuid,a uuid,p text,h text,t timestamptz,verification_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u for update;
 if not found then raise insufficient_privilege; end if;
 if e.state='SIGNED' then return to_jsonb(e); end if;
 if e.state<>'FINALIZING' or e.attempt_id is distinct from a or p not like c::text||'/sncr/hmg/'||eid::text||'/%' or h!~'^[0-9a-f]{64}$' or verification_data->>'isValid'<>'true' then
   raise exception 'O original assinado ainda não foi validado e armazenado.';
 end if;
 update public.sncr_numbering_items set state='USED' where environment=e.environment and number=e.number and state='RESERVED';
 if not found then raise exception 'Número indisponível para concluir esta emissão.'; end if;
 update public.sncr_rce_emissions set state='SIGNED',signed_pdf_path=p,signed_pdf_hash=h,signed_at=t,verification=verification_data,updated_at=now() where id=eid returning * into e;
 return to_jsonb(e);
end $$;

create function public.sncr_rce_cancel(eid uuid,c uuid,u uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u for update;
 if not found then raise insufficient_privilege; end if;
 if e.state<>'AWAITING_REVIEW' then raise exception 'Uma emissão que iniciou assinatura não pode ser descartada. Recupere o resultado.'; end if;
 update public.sncr_numbering_items set state='VOID' where environment=e.environment and number=e.number;
 update public.sncr_rce_emissions set state='CANCELLED',updated_at=now() where id=eid;
end $$;

create function public.sncr_rce_original_recovered(eid uuid,c uuid,u uuid,h text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u;
 if not found then raise insufficient_privilege; end if;
 if e.state<>'SIGNED' or h is distinct from e.signed_pdf_hash then raise exception 'O arquivo recuperado diverge do original.'; end if;
 insert into public.sncr_rce_events(emission_id,clinic_id,actor_id,state,attempt_id,action)
 values(eid,c,u,e.state,e.attempt_id,'ORIGINAL_RECOVERED');
end $$;

revoke all on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text),public.sncr_rce_acquire(uuid,uuid,uuid,text,boolean),
 public.sncr_rce_transition(uuid,uuid,uuid,uuid,text,text,jsonb),public.sncr_rce_finish(uuid,uuid,uuid,uuid,text,text,timestamptz,jsonb),public.sncr_rce_cancel(uuid,uuid,uuid),public.sncr_rce_original_recovered(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text),public.sncr_rce_acquire(uuid,uuid,uuid,text,boolean),
 public.sncr_rce_transition(uuid,uuid,uuid,uuid,text,text,jsonb),public.sncr_rce_finish(uuid,uuid,uuid,uuid,text,text,timestamptz,jsonb),public.sncr_rce_cancel(uuid,uuid,uuid),public.sncr_rce_original_recovered(uuid,uuid,uuid,text) to service_role;

-- Save structured draft fields through the existing, authorized/versioned RPC.
alter function public.document_write(uuid,jsonb) rename to document_write_before_rce;
revoke all on function public.document_write_before_rce(uuid,jsonb) from public,anon,authenticated;
create function public.document_write(c uuid,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; r public.clinical_documents; fields jsonb;
begin
 fields:=case when d->>'kind'='Receita' then nullif(d->'rce_fields','null'::jsonb) else null end;
 result:=public.document_write_before_rce(c,d);
 if result->'rce_fields' is not distinct from fields then return result; end if;
 update public.clinical_documents set rce_fields=fields where id=(result->>'id')::uuid returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.document_write(uuid,jsonb) from public,anon;
grant execute on function public.document_write(uuid,jsonb) to authenticated;
create function public.sncr_rce_lock_document() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.sncr_rce_emissions where document_id=old.id and state<>'CANCELLED') then
   raise exception 'Esta receita possui uma RCE eletrônica reservada ou assinada. Consulte a emissão ou duplique como novo rascunho.';
 end if;
 return coalesce(new,old);
end $$;
revoke all on function public.sncr_rce_lock_document() from public,anon,authenticated,service_role;
create trigger sncr_rce_lock_document before update or delete on public.clinical_documents for each row execute function public.sncr_rce_lock_document();
notify pgrst,'reload schema';
