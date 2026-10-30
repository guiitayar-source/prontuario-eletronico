-- LOCAL/STAGED ONLY: no production activation. Numbers are quarantined, never issued.
alter table public.clinical_documents add column prescription_category text
  check (prescription_category in ('RCE','RET','NRA','NRB','NRB2','NRR','NRT'));

create table public.sncr_numbering_requests (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id),
  user_id uuid not null references auth.users(id),
  environment text not null check(environment in ('hmg','prd')),
  category text not null check(category in ('RCE','RET','NRA','NRB','NRB2','NRR','NRT')),
  input jsonb not null,
  browser_hash text not null,
  state text not null default 'AUTH_PENDING' check(state in
    ('AUTH_PENDING','AUTH_EXPIRED','REQUESTING','AUTH_FAILED','REJECTED','UNKNOWN','RECEIVED_UNVERIFIED','CONTRACT_REVIEW')),
  expires_at timestamptz not null default now()+interval '5 minutes',
  raw_response jsonb,
  http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Across clinics: an unresolved request for the same prescriber/category must
-- not silently consume another quota. Operational resolution is required.
create unique index sncr_request_unresolved on public.sncr_numbering_requests(user_id,environment,category)
  where state in ('AUTH_PENDING','REQUESTING','UNKNOWN','RECEIVED_UNVERIFIED','CONTRACT_REVIEW');
create table public.sncr_numbering_items (
  environment text not null,
  number text not null,
  request_id uuid not null references public.sncr_numbering_requests(id),
  clinic_id uuid not null references public.clinics(id),
  user_id uuid not null references auth.users(id),
  -- No assignable/issued state until remote binding validation is supported.
  state text not null default 'QUARANTINED' check(state='QUARANTINED'),
  primary key(environment,number)
);
alter table public.sncr_numbering_requests enable row level security;
alter table public.sncr_numbering_items enable row level security;
revoke all on public.sncr_numbering_requests,public.sncr_numbering_items from public,anon,authenticated;
grant all on public.sncr_numbering_requests,public.sncr_numbering_items to service_role;
-- Service-role operations have auth.uid() = null; the generic record_change
-- trigger would omit them. Keep a separate append-only state history.
create table public.sncr_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.sncr_numbering_requests(id),
  clinic_id uuid not null references public.clinics(id),
  actor_id uuid not null references auth.users(id),
  state text not null,
  http_status integer,
  created_at timestamptz not null default now()
);
alter table public.sncr_request_events enable row level security;
revoke all on public.sncr_request_events from public,anon,authenticated,service_role;
grant select on public.sncr_request_events to service_role;
create function public.sncr_audit_request() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.sncr_request_events(request_id,clinic_id,actor_id,state,http_status)
    values(new.id,new.clinic_id,new.user_id,new.state,new.http_status);
  return new;
end $$;
revoke all on function public.sncr_audit_request() from public,anon,authenticated,service_role;
create trigger sncr_requests_audit after insert or update on public.sncr_numbering_requests
  for each row execute function public.sncr_audit_request();

create function public.sncr_claim_request(rid uuid,c uuid,u uuid,browser text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.sncr_numbering_requests;
begin
  select * into r from public.sncr_numbering_requests
    where id=rid and clinic_id=c and user_id=u and browser_hash=browser for update;
  if not found then raise insufficient_privilege; end if;
  if r.state<>'AUTH_PENDING' then raise exception 'Solicitação já processada. Consulte o resultado antes de repetir.'; end if;
  if r.expires_at<=now() then raise exception 'Autenticação expirada. Inicie uma nova solicitação.'; end if;
  update public.sncr_numbering_requests set state='REQUESTING',updated_at=now() where id=rid;
  return to_jsonb(r);
end $$;

create function public.sncr_store_numbers(rid uuid,c uuid,u uuid,numbers jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.sncr_numbering_requests; n text;
begin
  select * into r from public.sncr_numbering_requests where id=rid and clinic_id=c and user_id=u for update;
  if not found then raise insufficient_privilege; end if;
  if r.state<>'REQUESTING' or r.raw_response is null then raise exception 'Solicitação não está pronta para conferência.'; end if;
  if jsonb_typeof(numbers)<>'array' or jsonb_array_length(numbers) not between 1 and 1000 then raise exception 'Lote inválido.'; end if;
  for n in select jsonb_array_elements_text(numbers) loop
    if n!~'^[0-9]{4}\.[0-9]-[0-9]{2}\.[0-9]{7}$' then raise exception 'Formato de numeração não validado.'; end if;
    insert into public.sncr_numbering_items(environment,number,request_id,clinic_id,user_id)
      values(r.environment,n,rid,c,u);
  end loop;
  update public.sncr_numbering_requests set state='RECEIVED_UNVERIFIED',updated_at=now() where id=rid;
end $$;
revoke all on function public.sncr_claim_request(uuid,uuid,uuid,text),public.sncr_store_numbers(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sncr_claim_request(uuid,uuid,uuid,text),public.sncr_store_numbers(uuid,uuid,uuid,jsonb) to service_role;

-- Preserve the existing version/concurrency/author checks and RPC contract.
-- Revoking the underlying function prevents bypass through PostgREST.
alter function public.document_write(uuid,jsonb) rename to document_write_before_sncr;
revoke all on function public.document_write_before_sncr(uuid,jsonb) from public,anon,authenticated;
create function public.document_write(c uuid,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.clinical_documents; result jsonb; category text;
begin
  category:=case when d->>'kind'='Receita' then coalesce(d->>'prescription_category','RCE') else null end;
  select * into r from public.clinical_documents where id=(d->>'id')::uuid for update;
  if found and (r.clinic_id<>c or r.author_id<>auth.uid()) then raise insufficient_privilege; end if;
  if found and r.status in ('SIGNING','FINALIZED','SIGNED','SUPERSEDED') then raise exception 'Documento em assinatura ou finalizado é imutável.'; end if;
  if found and (d->>'version')::integer=0 and coalesce(r.prescription_category,'RCE') is distinct from category and r.kind='Receita' then
    raise exception 'Documento alterado em outra sessão. Reabra-o antes de salvar.';
  end if;
  result:=public.document_write_before_sncr(c,d);
  if result->>'prescription_category' is not distinct from category then return result; end if;
  update public.clinical_documents set prescription_category=category where id=(result->>'id')::uuid returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.document_write(uuid,jsonb) from public,anon;
grant execute on function public.document_write(uuid,jsonb) to authenticated;

-- Enforce the electronic cutoff in the DB as well as the server. Legacy rows
-- used the RCE template and are treated as RCE; they are not labeled integrated.
create function public.sncr_document_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and old.status='SIGNED' and new.status not in ('SIGNED','SUPERSEDED') then
    raise exception 'Documento assinado não pode retornar ao rascunho.';
  end if;
  if tg_op='UPDATE' and old.status='SIGNING' and
     (new.text is distinct from old.text or new.kind is distinct from old.kind or
      new.patient_id is distinct from old.patient_id or new.patient_name is distinct from old.patient_name or
      new.clinic_id is distinct from old.clinic_id or new.author_id is distinct from old.author_id or
      new.physician_name is distinct from old.physician_name or new.physician_registration is distinct from old.physician_registration or
      new.document_date is distinct from old.document_date or new.consultation_id is distinct from old.consultation_id) then
    raise exception 'Documento em assinatura é imutável.';
  end if;
  if tg_op='UPDATE' and old.status in ('SIGNING','SIGNED','FINALIZED','SUPERSEDED') and
     new.prescription_category is distinct from old.prescription_category then
    raise exception 'Categoria de documento em assinatura ou finalizado é imutável.';
  end if;
  if new.kind='Receita' and new.status in ('SIGNING','SIGNED') and
     (tg_op='INSERT' or new.status is distinct from old.status) then
    if coalesce(new.prescription_category,'RCE')<>'RCE' or (now() at time zone 'America/Sao_Paulo')::date>='2026-10-30' then
      raise exception 'Emissão eletrônica indisponível: integração SNCR e modelo devem ser validados. Utilize a via física adequada.';
    end if;
  end if;
  return new;
end $$;
create trigger sncr_document_guard before insert or update on public.clinical_documents
  for each row execute function public.sncr_document_guard();
notify pgrst,'reload schema';
