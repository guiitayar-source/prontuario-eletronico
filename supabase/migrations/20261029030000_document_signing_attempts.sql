-- Lote 6E: somente cópia em PostgreSQL descartável. Promoção exige revisão própria.
do $$ begin
 raise exception 'Migração de tentativas de assinatura em revisão: não aplicar';
end $$;

-- Estende o congelamento 6B ao estado terminal SUPERSEDED, inclusive em
-- documentos históricos sem tentativa 6E. SIGNED -> SUPERSEDED continua legítimo.
create or replace function public.signature_document_identity_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if old.status in ('SIGNING','SIGNED','SUPERSEDED') then
  if tg_op='DELETE' then raise exception 'Documento em assinatura ou assinado deve ser conservado.' using errcode='23514'; end if;
  if (to_jsonb(new)-array['status','signed_pdf_path','updated_at']) is distinct from
   (to_jsonb(old)-array['status','signed_pdf_path','updated_at']) then
   raise exception 'Identidade e versão do documento assinado são imutáveis.' using errcode='23514';
  end if;
  if old.status in ('SIGNED','SUPERSEDED') and (new.signed_pdf_path is distinct from old.signed_pdf_path or
   (old.status='SIGNED' and new.status not in ('SIGNED','SUPERSEDED')) or
   (old.status='SUPERSEDED' and new.status<>'SUPERSEDED')) then
   raise exception 'Assinatura concluída não pode ser substituída ou reiniciada.' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
revoke all on function public.signature_document_identity_guard() from public,anon,authenticated,service_role;

create index document_signing_legacy_audit_idx on public.audit_events(clinic_id,lower(entity_id))
 where entity_type='clinical_documents' and action in ('document.signature_started','document.signature_pending','document.signed');

create table public.document_signing_attempts (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics on delete restrict,
 document_id uuid not null references public.clinical_documents on delete restrict,
 document_version integer not null check(document_version>0),
 user_id uuid not null references auth.users on delete restrict,
 idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
 session_id uuid not null references public.signature_sessions on delete restrict,
 provider text not null check(provider in ('birdid','vidaas')),
 signer_cpf text not null check(signer_cpf ~ '^[0-9]{11}$'),
 certificate_fingerprint text not null,
 certificate_raw text not null,
 document_snapshot jsonb not null,
 state text not null check(state in ('ACQUIRED','PREPARED','EXTERNAL_STARTED','UNCERTAIN','ARTIFACT_RECEIVED','ARTIFACT_STORED','COMPLETED','PREPARATION_FAILED','REJECTED')),
 owner_token uuid not null,
 lease_until timestamptz not null,
 document_hash text,
 unsigned_pdf_hash text,
 provider_transaction_id text,
 artifact_metadata jsonb,
 artifact_cipher text,
 artifact_object_id uuid,
 storage_path text not null unique,
 created_at timestamptz not null default now(),
 external_started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz not null default now(),
 unique(document_id,document_version),
 unique(clinic_id,user_id,idempotency_key)
);
create table public.document_signing_events (
 id bigint generated always as identity primary key,
 attempt_id uuid not null references public.document_signing_attempts on delete restrict,
 from_state text,to_state text not null,reason text not null,
 created_at timestamptz not null default now()
);
alter table public.document_signing_attempts enable row level security;
alter table public.document_signing_events enable row level security;
revoke all on public.document_signing_attempts,public.document_signing_events from public,anon,authenticated,service_role;
grant select on public.document_signing_attempts,public.document_signing_events to service_role;
revoke all on sequence public.document_signing_events_id_seq from public,anon,authenticated,service_role;
-- Metadados comuns e SNCR são concluídos pelas respectivas RPCs DEFINER.
revoke insert on public.digital_signatures from service_role;
alter table public.digital_signatures add column signing_attempt_id uuid unique references public.document_signing_attempts on delete restrict;

-- Trigger sem EXECUTE para clientes. Abrange também caminhos históricos
-- registrados, sem modificar os objetos ou metadados existentes.
create function public.signed_artifact_storage_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare path text; bucket text; a public.document_signing_attempts; protected boolean;
begin
 path:=case when tg_op='DELETE' then old.name else new.name end;
 bucket:=case when tg_op='DELETE' then old.bucket_id else new.bucket_id end;
 protected:=bucket='clinical-files' and (path ~ '^[^/]+/signature-attempts/' or
  exists(select 1 from public.digital_signatures where signed_pdf_storage_path=path and status='SIGNED') or
  exists(select 1 from public.clinical_documents where signed_pdf_path=path and status in ('SIGNED','SUPERSEDED')));
 if tg_op='UPDATE' and old.bucket_id='clinical-files' then
  protected:=protected or old.name ~ '^[^/]+/signature-attempts/' or
   exists(select 1 from public.digital_signatures where signed_pdf_storage_path=old.name and status='SIGNED') or
   exists(select 1 from public.clinical_documents where signed_pdf_path=old.name and status in ('SIGNED','SUPERSEDED'));
 end if;
 if protected then
  if tg_op<>'INSERT' then raise exception 'Artefato assinado é imutável.' using errcode='23514'; end if;
  if coalesce(auth.role(),'')<>'service_role' then
   raise exception 'Armazenamento de assinatura restrito ao backend.' using errcode='42501';
  end if;
  select * into a from public.document_signing_attempts where storage_path=path;
  if not found or a.state<>'ARTIFACT_RECEIVED' or new.user_metadata->>'attempt_id' is distinct from a.id::text or
   new.user_metadata->>'sha256' is distinct from a.artifact_metadata->>'signed_pdf_hash' or
   (coalesce(new.metadata->>'size',new.metadata->>'contentLength') is not null and
    coalesce(new.metadata->>'size',new.metadata->>'contentLength')::bigint is distinct from (a.artifact_metadata->>'byte_length')::bigint) then
   raise exception 'Objeto incompatível com a tentativa recebida.' using errcode='23514';
  end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
-- O trigger precisa ler vínculos privados mesmo nas transações da Storage API.
-- DEFINER limitado ao trigger e sem execução direta por clientes.
alter function public.signed_artifact_storage_guard() security definer;
create trigger signed_artifact_storage_preserved before insert or update or delete on storage.objects
 for each row execute function public.signed_artifact_storage_guard();
revoke all on function public.signed_artifact_storage_guard() from public,anon,authenticated,service_role;

create function public.signing_attempt_document_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare a public.document_signing_attempts;
begin
 select * into a from public.document_signing_attempts where document_id=old.id and document_version=old.version;
 if not found then if tg_op='DELETE' then return old; end if; return new; end if;
 if tg_op='DELETE' then raise exception 'Documento com tentativa deve ser preservado.' using errcode='23514'; end if;
 if old.status='SUPERSEDED' and new.status<>'SUPERSEDED' then raise exception 'Documento substituído não pode ser reativado.' using errcode='23514'; end if;
 if a.state<>'PREPARATION_FAILED' then
  if (to_jsonb(new)-array['status','signed_pdf_path','updated_at']) is distinct from a.document_snapshot then
   raise exception 'Versão adquirida é imutável.' using errcode='23514';
  end if;
  if new.status='SIGNED' then
   if a.state<>'COMPLETED' or new.signed_pdf_path is distinct from a.storage_path or
    not exists(select 1 from public.digital_signatures where signing_attempt_id=a.id and signed_pdf_storage_path=a.storage_path) then
    raise exception 'Conclusão fora da tentativa autorizada.' using errcode='23514'; end if;
  elsif old.status in ('SIGNED','SUPERSEDED') and new.status='SUPERSEDED' and new.signed_pdf_path is not distinct from old.signed_pdf_path then null;
  elsif new.status<>'SIGNING' or new.signed_pdf_path is distinct from old.signed_pdf_path then
   raise exception 'Transição documental incompatível com a tentativa.' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
alter function public.signing_attempt_document_guard() security definer;
create trigger signing_attempt_document_preserved before update or delete on public.clinical_documents
 for each row execute function public.signing_attempt_document_guard();
revoke all on function public.signing_attempt_document_guard() from public,anon,authenticated,service_role;

create function public.signing_attempt_metadata_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare a public.document_signing_attempts;
begin
 select * into a from public.document_signing_attempts where document_id=new.document_id and document_version=new.document_version;
 if found or new.signing_attempt_id is not null then
  if a.id is null or new.signing_attempt_id is distinct from a.id or a.state<>'ARTIFACT_STORED' or
   new.clinic_id<>a.clinic_id or new.signer_user_id<>a.user_id or new.signer_doctor_id<>a.user_id or
   new.signed_pdf_storage_path is distinct from a.storage_path or new.signed_pdf_hash is distinct from a.artifact_metadata->>'signed_pdf_hash' or
   new.certificate_fingerprint is distinct from a.certificate_fingerprint or new.cpf_from_certificate is distinct from a.signer_cpf or
   new.verification_status<>'UNVERIFIED' then
   raise exception 'Metadados incompatíveis com a tentativa.' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
create trigger signing_attempt_metadata_preserved before insert on public.digital_signatures
 for each row execute function public.signing_attempt_metadata_guard();
revoke all on function public.signing_attempt_metadata_guard() from public,anon,authenticated,service_role;

create function public.document_signing_operation(
 p_action text,p_clinic uuid,p_user uuid,p_document uuid,p_version integer,p_key text,
 p_owner uuid default null,p_data jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare d public.clinical_documents; a public.document_signing_attempts; s public.signature_sessions;
 profile public.document_profiles; sig public.digital_signatures; previous text; claimed boolean:=false; oid uuid; meta jsonb;
begin
 if p_action is null or p_action not in ('inspect','acquire','prepare','external','external_reference','receive','stored','finish','preparation_failed','uncertain','reject') or
  p_clinic is null or p_user is null or p_document is null or p_version is null or p_version<1 or p_key is null or p_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
  raise exception 'Solicitação de assinatura inválida.' using errcode='22023';
 end if;
 select * into d from public.clinical_documents where id=p_document and clinic_id=p_clinic for update;
 if not found or d.author_id<>p_user then raise exception 'Autoria incompatível.' using errcode='42501'; end if;
 perform 1 from public.clinic_members where clinic_id=p_clinic and user_id=p_user and role in ('owner','doctor') for share;
 if not found then raise exception 'Usuário sem autorização médica.' using errcode='42501'; end if;
 if d.version<>p_version then raise exception 'Versão documental alterada.' using errcode='40001'; end if;
 -- Receita com RCE eletrônica (reservada ou assinada) segue o fluxo SNCR da main; categorias
 -- além de RCE não têm modelo eletrônico neste fluxo (lib/sncr/policy.ts).
 if exists(select 1 from public.sncr_rce_emissions where document_id=d.id and state<>'CANCELLED') or
  (d.kind='Receita' and coalesce(d.prescription_category,'RCE')<>'RCE') then
  raise exception 'Receita desta categoria ou com RCE eletrônica segue o fluxo SNCR.' using errcode='23514';
 end if;
 select * into a from public.document_signing_attempts where clinic_id=p_clinic and user_id=p_user and idempotency_key=p_key for update;
 if found and (a.document_id<>p_document or a.document_version<>p_version) then
  raise exception 'Chave de idempotência usada com parâmetros incompatíveis.' using errcode='23505';
 end if;
 if a.id is null then
  select * into a from public.document_signing_attempts where document_id=p_document and document_version=p_version for update;
  if found and a.idempotency_key<>p_key then raise exception 'Versão já vinculada a outra tentativa.' using errcode='23505'; end if;
 end if;
 previous:=a.state;
 if a.id is not null and a.state='EXTERNAL_STARTED' and a.lease_until<=now() then
  update public.document_signing_attempts set state='UNCERTAIN',updated_at=now() where id=a.id returning * into a;
 end if;
 if p_action='inspect' then null;
 elsif p_action='acquire' then
  if p_owner is null then raise exception 'Prova de aquisição ausente.' using errcode='22023'; end if;
  -- Mesma ordem de locks do OAuth 6D: perfil antes de sessões.
  select * into profile from public.document_profiles where clinic_id=p_clinic and user_id=p_user for share;
  select * into s from public.signature_sessions where id=(p_data->>'session_id')::uuid and clinic_id=p_clinic and user_id=p_user for share;
  if s.id is null or s.revoked or s.expires_at<=now() or s.cpf is distinct from p_data->>'cpf' or
   regexp_replace(coalesce(profile.cpf,''),'[^0-9]','','g') is distinct from s.cpf or
   nullif(profile.physician_registration,'') is null or profile.physician_registration is distinct from d.physician_registration or
   s.certificate_raw is null or s.certificate_raw is distinct from p_data->>'certificate_raw' or
   coalesce(p_data->>'fingerprint','') !~ '^[A-Fa-f0-9:]{64,95}$' or
   replace(lower(p_data->>'fingerprint'),':','') is distinct from
    encode(sha256(decode(regexp_replace(s.certificate_raw,'-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s','','g'),'base64')),'hex') then
   raise exception 'Identidade de assinatura incompatível.' using errcode='23514';
  end if;
  if a.id is not null and (a.session_id<>s.id or a.signer_cpf<>s.cpf or a.certificate_fingerprint is distinct from p_data->>'fingerprint' or a.certificate_raw<>s.certificate_raw) then
   raise exception 'Chave de idempotência usada com outra identidade.' using errcode='23505';
  end if;
  if a.id is null then
   -- Não interpreta falha histórica como prova de que o HSM não assinou.
   -- Versão nova após uma preparação 6E comprovadamente pré-HSM é legítima.
   if d.status='SIGNATURE_FAILED' and not exists(select 1 from public.document_signing_attempts
    where document_id=d.id and state='PREPARATION_FAILED' and document_version<p_version) then
    raise exception 'Falha histórica sem recibo de fase exige reconciliação.' using errcode='23514';
   end if;
   if exists(select 1 from public.digital_signatures where document_id=p_document and document_version=p_version) or
    exists(select 1 from public.audit_events where clinic_id=p_clinic and entity_type='clinical_documents' and lower(entity_id)=p_document::text and
     action in ('document.signature_started','document.signature_pending','document.signed') and
     coalesce(context->>'document_version',context->>'version')=p_version::text) then
    raise exception 'Versão com operação histórica exige reconciliação, sem nova assinatura.' using errcode='23514';
   end if;
   if d.status not in ('DRAFT','FINALIZED','SIGNATURE_FAILED') or d.signed_pdf_path is not null then
    raise exception 'Documento indisponível para aquisição.' using errcode='40001'; end if;
   if d.document_date is null then
    update public.clinical_documents set document_date=(now() at time zone 'America/Sao_Paulo')::date where id=d.id returning * into d;
   end if;
   insert into public.document_signing_attempts(clinic_id,document_id,document_version,user_id,idempotency_key,session_id,provider,signer_cpf,certificate_fingerprint,certificate_raw,document_snapshot,state,owner_token,lease_until,storage_path)
    values(p_clinic,p_document,p_version,p_user,p_key,s.id,s.provider,s.cpf,p_data->>'fingerprint',s.certificate_raw,
     to_jsonb(d)-array['status','signed_pdf_path','updated_at'],'ACQUIRED',p_owner,now()+interval '2 minutes','pending:'||gen_random_uuid()::text) returning * into a;
   update public.document_signing_attempts set storage_path=p_clinic::text||'/signature-attempts/'||p_document::text||'_v'||p_version::text||'/'||a.id::text||'.pdf' where id=a.id returning * into a;
   claimed:=true;
  elsif a.state='PREPARATION_FAILED' or (a.state in ('ACQUIRED','PREPARED') and a.lease_until<=now()) then
   if (to_jsonb(d)-array['status','signed_pdf_path','updated_at']) is distinct from a.document_snapshot then
    raise exception 'Versão da tentativa alterada.' using errcode='23514'; end if;
   update public.document_signing_attempts set state='ACQUIRED',owner_token=p_owner,lease_until=now()+interval '2 minutes',document_hash=null,unsigned_pdf_hash=null,updated_at=now() where id=a.id returning * into a;
   claimed:=true;
  end if;
  if claimed then update public.clinical_documents set status='SIGNING' where id=d.id returning * into d; end if;
 else
  if a.id is null then raise exception 'Tentativa inexistente.' using errcode='23514'; end if;
  if p_action not in ('stored','finish') and (p_owner is null or p_owner<>a.owner_token) then
   raise exception 'Aquisição substituída ou incompatível.' using errcode='40001'; end if;
  if p_action='prepare' then
   if a.state<>'ACQUIRED' or a.lease_until<=now() or coalesce(p_data->>'document_hash','') !~ '^[a-f0-9]{64}$' or coalesce(p_data->>'unsigned_pdf_hash','') !~ '^[a-f0-9]{64}$' then
    raise exception 'Preparação incompatível.' using errcode='40001'; end if;
   update public.document_signing_attempts set state='PREPARED',document_hash=p_data->>'document_hash',unsigned_pdf_hash=p_data->>'unsigned_pdf_hash',lease_until=now()+interval '2 minutes',updated_at=now() where id=a.id returning * into a;
  elsif p_action='external' then
   if a.state<>'PREPARED' or a.lease_until<=now() then raise exception 'Operação externa já adquirida ou incerta.' using errcode='40001'; end if;
   update public.document_signing_attempts set state='EXTERNAL_STARTED',external_started_at=now(),lease_until=now()+interval '2 minutes',updated_at=now() where id=a.id returning * into a;
  elsif p_action='external_reference' then
   if a.state in ('EXTERNAL_STARTED','UNCERTAIN') and coalesce(p_data->>'transaction_id','') ~ '^[A-Za-z0-9._:-]{1,200}$' then
    if a.provider_transaction_id is not null and a.provider_transaction_id<>p_data->>'transaction_id' then raise exception 'Referência externa divergente.' using errcode='23514'; end if;
    update public.document_signing_attempts set provider_transaction_id=p_data->>'transaction_id' where id=a.id returning * into a;
   end if;
  elsif p_action='receive' then
   meta:=p_data->'metadata';
   if a.state not in ('EXTERNAL_STARTED','UNCERTAIN') or meta->>'signed_pdf_storage_path' is distinct from a.storage_path or
    meta->>'document_hash' is distinct from a.document_hash or meta->>'unsigned_pdf_hash' is distinct from a.unsigned_pdf_hash or
    meta->>'cpf_from_certificate' is distinct from a.signer_cpf or meta->>'certificate_fingerprint' is distinct from a.certificate_fingerprint or
    coalesce(meta->>'signed_pdf_hash','') !~ '^[a-f0-9]{64}$' or coalesce((meta->>'byte_length')::bigint,0) not between 1 and 16777216 or
    coalesce(length(p_data->>'cipher'),0) not between 1 and 50331648 then
    raise exception 'Artefato recebido incompatível.' using errcode='23514'; end if;
   update public.document_signing_attempts set state='ARTIFACT_RECEIVED',artifact_metadata=meta,artifact_cipher=p_data->>'cipher',
    provider_transaction_id=coalesce(provider_transaction_id,case when meta->>'provider_transaction_id' ~ '^[A-Za-z0-9._:-]{1,200}$' then meta->>'provider_transaction_id' end),updated_at=now() where id=a.id returning * into a;
  elsif p_action='stored' then
   if a.state not in ('ARTIFACT_RECEIVED','ARTIFACT_STORED','COMPLETED') then raise exception 'Artefato não recebido.' using errcode='23514'; end if;
   if a.state='ARTIFACT_RECEIVED' then
    select id into oid from storage.objects where bucket_id='clinical-files' and name=a.storage_path and user_metadata->>'attempt_id'=a.id::text and
     user_metadata->>'sha256'=a.artifact_metadata->>'signed_pdf_hash' and (metadata->>'size')::bigint=(a.artifact_metadata->>'byte_length')::bigint;
    if not found then raise exception 'Existência do artefato não confirmada.' using errcode='23514'; end if;
    update public.document_signing_attempts set state='ARTIFACT_STORED',artifact_object_id=oid,updated_at=now() where id=a.id returning * into a;
   end if;
  elsif p_action='finish' then
   if a.state not in ('ARTIFACT_STORED','COMPLETED') then raise exception 'Artefato ainda não persistido.' using errcode='23514'; end if;
   if a.state<>'COMPLETED' then
    if not exists(select 1 from storage.objects where id=a.artifact_object_id and bucket_id='clinical-files' and name=a.storage_path and user_metadata->>'sha256'=a.artifact_metadata->>'signed_pdf_hash') then
     raise exception 'Artefato original ausente ou incompatível.' using errcode='23514'; end if;
    meta:=a.artifact_metadata||jsonb_build_object('id',gen_random_uuid(),'clinic_id',p_clinic,'document_id',p_document,'document_version',p_version,'signer_user_id',p_user,'signer_doctor_id',p_user,'provider',a.provider,'signing_attempt_id',a.id,
     'status','SIGNED','verification_status','UNVERIFIED','signature_format','PAdES-B-B','signed_at',now(),'created_at',now(),'provider_transaction_id',a.provider_transaction_id);
    insert into public.digital_signatures select (jsonb_populate_record(null::public.digital_signatures,meta)).* returning * into sig;
    update public.document_signing_attempts set state='COMPLETED',artifact_cipher=null,completed_at=now(),updated_at=now() where id=a.id returning * into a;
    update public.clinical_documents set status='SIGNED',signed_pdf_path=a.storage_path,updated_at=now() where id=d.id returning * into d;
   end if;
  elsif p_action='preparation_failed' then
   if a.state in ('ACQUIRED','PREPARED') then
    update public.document_signing_attempts set state='PREPARATION_FAILED',updated_at=now() where id=a.id returning * into a;
    update public.clinical_documents set status='SIGNATURE_FAILED' where id=d.id returning * into d;
   end if;
  elsif p_action='uncertain' then
   if a.state='EXTERNAL_STARTED' then update public.document_signing_attempts set state='UNCERTAIN',updated_at=now() where id=a.id returning * into a; end if;
  elsif p_action='reject' then
   if a.state in ('EXTERNAL_STARTED','UNCERTAIN') then update public.document_signing_attempts set state='REJECTED',updated_at=now() where id=a.id returning * into a; end if;
  end if;
 end if;
 -- Revalidação no banco ANTES de liberar HSM e ANTES da conclusão atômica.
 if p_action in ('external','finish') and previous<>'COMPLETED' then
  select * into profile from public.document_profiles where clinic_id=p_clinic and user_id=p_user for share;
  select * into s from public.signature_sessions where id=a.session_id for share;
  if d.status not in ('SIGNING','SIGNED') or (to_jsonb(d)-array['status','signed_pdf_path','updated_at']) is distinct from a.document_snapshot or
   s.user_id<>p_user or s.clinic_id<>p_clinic or s.revoked or s.expires_at<=now() or s.cpf is distinct from a.signer_cpf or s.certificate_raw is distinct from a.certificate_raw or
   regexp_replace(coalesce(profile.cpf,''),'[^0-9]','','g') is distinct from a.signer_cpf or profile.physician_registration is distinct from d.physician_registration then
   raise exception 'Identidade ou versão mudou durante a tentativa.' using errcode='23514'; end if;
 end if;
 if a.id is not null and previous is distinct from a.state then
  insert into public.document_signing_events(attempt_id,from_state,to_state,reason) values(a.id,previous,a.state,p_action);
  insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context) values(p_clinic,p_user,'document.signature_transition','clinical_documents',p_document,jsonb_build_object('attempt_id',a.id,'document_version',p_version,'state',a.state,'reason',p_action));
 end if;
 if a.state='COMPLETED' then select * into sig from public.digital_signatures where signing_attempt_id=a.id; end if;
 return jsonb_build_object('attempt',case when a.id is null then null else to_jsonb(a) end,'document',to_jsonb(d),'signature',case when sig.id is null then null else to_jsonb(sig) end,'claimed',claimed);
end $$;
revoke all on function public.document_signing_operation(text,uuid,uuid,uuid,integer,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.document_signing_operation(text,uuid,uuid,uuid,integer,text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
