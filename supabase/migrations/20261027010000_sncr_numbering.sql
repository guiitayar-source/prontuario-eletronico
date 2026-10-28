-- Aplicação deliberadamente bloqueada. Validar/revisar a promoção separadamente.
-- Lote 3A: infraestrutura local; não verifica identidade perante a Anvisa.
do $$ begin
 raise exception 'Migração SNCR em revisão: não aplicar';
end $$;
-- Estoque SNCR: não importa dados antigos nem considera lotes manuais verificados.
-- Escrita exclusivamente por backend confiável; nenhum acesso direto por clientes.
-- btree_gist faz parte do PostgreSQL e permite impedir sobreposição no índice,
-- inclusive entre transações com snapshots diferentes (sem depender de SELECT).
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- Somente o administrador de um banco local descartável pode cadastrar a clínica sintética.
create table public.sncr_local_sandboxes (
 clinic_id uuid primary key references public.clinics(id) on delete restrict,
 label text not null check (label='synthetic-local-only')
);
alter table public.sncr_local_sandboxes enable row level security;
revoke all on public.sncr_local_sandboxes from public,anon,authenticated,service_role;
grant select on public.sncr_local_sandboxes to service_role;

create table public.sncr_requests (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 prescriber_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check (environment in ('hmg','prd')),
 modality text not null check (modality in ('controle_especial','retencao','notificacao_a','notificacao_b')),
 request_key uuid not null,
 origin text not null check (origin in ('anvisa_api','synthetic','manual','legacy')),
 state text not null check (state in ('pending','uncertain','completed','failed','quarantined')),
 organization_cnpj text check (organization_cnpj is null or organization_cnpj ~ '^[0-9]{14}$'),
 external_reference text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (clinic_id,prescriber_id,request_key),
 unique (id,clinic_id,prescriber_id,environment,modality,origin),
 unique (id,clinic_id,prescriber_id),
 check (origin in ('anvisa_api','synthetic') or state='quarantined')
);

create table public.sncr_batches (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.sncr_requests(id) on delete restrict,
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 prescriber_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check (environment in ('hmg','prd')),
 modality text not null check (modality in ('controle_especial','retencao','notificacao_a','notificacao_b')),
 council text not null check (council in ('CRM','CRO','CRMV')),
 council_number text not null check (council_number ~ '^[0-9]{3,10}$'),
 council_uf text not null check (council_uf in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
 registration_snapshot text not null check (length(trim(registration_snapshot)) > 0),
 organization_cnpj text check (organization_cnpj is null or organization_cnpj ~ '^[0-9]{14}$'),
 number_prefix text collate "C" not null check (length(number_prefix) between 1 and 50 and number_prefix !~ '[0-9]$' and number_prefix=btrim(number_prefix)),
 suffix_width integer not null check (suffix_width between 1 and 15),
 first_suffix bigint not null check (first_suffix >= 0),
 last_suffix bigint not null,
 next_suffix bigint not null,
 origin text not null check (origin in ('anvisa_api','synthetic','manual','legacy')),
 verification_state text not null default 'quarantined' check (verification_state in ('quarantined','verified','invalid')),
 created_at timestamptz not null default now(),
 check (last_suffix >= first_suffix and next_suffix between first_suffix and last_suffix + 1),
 check (length(last_suffix::text) <= suffix_width),
 check (origin in ('anvisa_api','synthetic') or verification_state <> 'verified'),
 check (origin<>'synthetic' or (environment='hmg' and number_prefix like 'SIMULADO.%')),
 unique (request_id,number_prefix,first_suffix,last_suffix),
 unique (id,clinic_id,prescriber_id,environment,modality),
 foreign key (request_id,clinic_id,prescriber_id,environment,modality,origin)
 references public.sncr_requests(id,clinic_id,prescriber_id,environment,modality,origin) on delete restrict
);
-- A extensão pode já existir em outro schema: usar suas classes explicitamente.
do $$ declare ext_schema text; begin
 select n.nspname into strict ext_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='btree_gist';
 execute format('alter table public.sncr_batches add constraint sncr_batches_no_overlap exclude using gist
 (environment %I.gist_text_ops with =, number_prefix %I.gist_text_ops with =,
 suffix_width %I.gist_int4_ops with =, int8range(first_suffix,last_suffix,''[]'') with &&)',ext_schema,ext_schema,ext_schema);
end $$;
create index sncr_batches_available_idx on public.sncr_batches
 (clinic_id,prescriber_id,environment,modality,created_at) where verification_state='verified';

-- A restrição EXCLUDE acima garante a exclusividade entre clínicas e prescritores.
-- O gatilho mantém os atributos e o cursor do lote imutáveis/monotônicos.
create function public.sncr_check_batch_overlap() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='DELETE' then
  raise exception 'Lotes SNCR devem ser conservados.' using errcode='23514';
 elsif tg_op='UPDATE' then
  if (to_jsonb(new)-array['next_suffix','verification_state']) is distinct from (to_jsonb(old)-array['next_suffix','verification_state'])
     or new.next_suffix not in (old.next_suffix,old.next_suffix+1) then
   raise exception 'Identidade, faixa e cursor SNCR não podem ser reutilizados ou reescritos.' using errcode='23514';
  end if;
 elsif new.next_suffix<>new.first_suffix then
  raise exception 'Lote SNCR deve começar no início da faixa.' using errcode='23514';
 end if;
 if not exists (select 1 from public.sncr_requests r where r.id=new.request_id
   and r.clinic_id=new.clinic_id and r.prescriber_id=new.prescriber_id
   and r.environment=new.environment and r.modality=new.modality and r.origin=new.origin
   and r.organization_cnpj is not distinct from new.organization_cnpj) then
  raise exception 'Lote SNCR incompatível com a requisição.' using errcode='23514';
 end if;
 return new;
end $$;
create trigger sncr_batches_overlap before insert or update or delete on public.sncr_batches
 for each row execute function public.sncr_check_batch_overlap();

create table public.sncr_reservations (
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.sncr_batches(id) on delete restrict,
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 prescriber_id uuid not null references auth.users(id) on delete restrict,
 document_id uuid not null references public.clinical_documents(id) on delete restrict,
 document_version integer not null check (document_version > 0),
 environment text not null check (environment in ('hmg','prd')),
 modality text not null check (modality in ('controle_especial','retencao','notificacao_a','notificacao_b')),
 request_key uuid not null,
 number text collate "C" not null,
 state text not null default 'reserved' check (state in ('reserved','signing','uncertain','abandoned','signed')),
 state_reason text,
 attempt_id uuid check (attempt_id is null or attempt_id=id),
 artifact_metadata jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(environment,number),
 unique(document_id),
 unique(clinic_id,prescriber_id,request_key),
 unique(id,clinic_id,prescriber_id),
 foreign key(batch_id,clinic_id,prescriber_id,environment,modality)
 references public.sncr_batches(id,clinic_id,prescriber_id,environment,modality) on delete restrict
);

create table public.sncr_operation_history (
 id bigint generated always as identity primary key,
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 prescriber_id uuid not null references auth.users(id) on delete restrict,
 request_id uuid references public.sncr_requests(id) on delete restrict,
 reservation_id uuid references public.sncr_reservations(id) on delete restrict,
 action text not null,
 details jsonb not null default '{}'::jsonb,
 occurred_at timestamptz not null default now(),
 check (request_id is not null or reservation_id is not null),
 foreign key(request_id,clinic_id,prescriber_id) references public.sncr_requests(id,clinic_id,prescriber_id) on delete restrict,
 foreign key(reservation_id,clinic_id,prescriber_id) references public.sncr_reservations(id,clinic_id,prescriber_id) on delete restrict
);

alter table public.sncr_requests enable row level security;
alter table public.sncr_batches enable row level security;
alter table public.sncr_reservations enable row level security;
alter table public.sncr_operation_history enable row level security;
revoke all on public.sncr_requests,public.sncr_batches,public.sncr_reservations,public.sncr_operation_history from public,anon,authenticated,service_role;
grant select on public.sncr_requests,public.sncr_batches,public.sncr_reservations,public.sncr_operation_history to service_role;
revoke all on sequence public.sncr_operation_history_id_seq from public,anon,authenticated,service_role;

-- O cabeçalho clínico é a fonte da modalidade. Nenhuma modalidade é inferida
-- de um parâmetro do navegador. Sem cabeçalho = controle especial (modelo atual).
create function public.sncr_document_modality(p_text text) returns text
language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare line text; header text; result text := 'controle_especial'; seen boolean := false;
begin
 for line in select unnest(string_to_array(replace(replace(coalesce(p_text,''),E'\r\n',E'\n'),E'\r',E'\n'),E'\n')) loop
  line := btrim(line);
  if line='' then continue; end if;
  if line ~* '^modalidade:\s*' then
   if seen then raise exception 'Cabeçalho de modalidade repetido.' using errcode='22023'; end if;
   seen := true;
   header := lower(btrim(regexp_replace(line,'^modalidade:\s*','','i')));
   result := case
    when header in ('controle especial','receituario de controle especial','receituário de controle especial','controle_especial') then 'controle_especial'
    when header in ('retencao','retenção','receita sujeita a retencao','receita sujeita a retenção','receituario sujeito a retencao','receituário sujeito a retenção') then 'retencao'
    when header in ('notificacao_b','notificação de receita b','notificacao de receita b','notificação b') then 'notificacao_b'
    when header in ('notificacao_a','notificação de receita a','notificacao de receita a','notificação a') then 'notificacao_a'
    else 'invalid' end;
   continue;
  end if;
  if line ~* '^(n[º°o]?\s*)?sncr:\s*' or line ~* '^via\s+de\s+administra[cç][aã]o:\s*' then continue; end if;
  exit;
 end loop;
 return result;
end $$;

-- Confere somente a coerência local, sem validar habilitação ou identidade Anvisa.
-- Exige conselho e UF explícitos: nenhum fallback silencioso para SP.
create function public.sncr_registration_matches(raw text,council text,council_number text,council_uf text) returns boolean
language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare before_rqe text; num text[];
begin
 before_rqe := split_part(upper(coalesce(raw,'')),'RQE',1);
 num := regexp_match(before_rqe,'\m([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{3,10})\M');
 return coalesce(before_rqe ~ ('\m'||council||'\M')
  and before_rqe ~ ('\m'||council_uf||'\M')
  and regexp_replace(num[1],'[^0-9]','','g')=council_number,false);
end $$;

create function public.sncr_validate_reservation() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare d public.clinical_documents; b public.sncr_batches; profile public.document_profiles;
begin
 if tg_op='DELETE' then
  raise exception 'Reserva SNCR não pode ser apagada ou devolvida ao estoque.' using errcode='23514';
 elsif tg_op='UPDATE' then
  if (to_jsonb(new)-array['state','state_reason','updated_at','attempt_id','artifact_metadata']) is distinct from (to_jsonb(old)-array['state','state_reason','updated_at','attempt_id','artifact_metadata']) then
   raise exception 'Vínculo da reserva SNCR é imutável.' using errcode='23514';
  end if;
  if old.attempt_id is not null and new.attempt_id is distinct from old.attempt_id
    or (new.attempt_id is distinct from old.attempt_id and not (old.state='reserved' and new.state='signing' and new.attempt_id=new.id))
    or (old.artifact_metadata is not null and new.artifact_metadata is distinct from old.artifact_metadata)
    or (new.artifact_metadata is distinct from old.artifact_metadata and old.state not in ('signing','uncertain')) then
   raise exception 'Tentativa/artefato de assinatura é imutável.' using errcode='23514';
  end if;
  if new.artifact_metadata is not null and new.attempt_id is null then raise exception 'Artefato exige tentativa persistida.' using errcode='23514'; end if;
  if new.state=old.state and new.state_reason is not distinct from old.state_reason then
   if new.artifact_metadata is distinct from old.artifact_metadata then new.updated_at:=clock_timestamp(); end if;
   return new;
  end if;
  if not ((old.state='reserved' and new.state in ('signing','uncertain','abandoned')) or (old.state='signing' and new.state in ('signed','uncertain')) or (old.state='uncertain' and new.state in ('abandoned','signed')))
    or length(btrim(coalesce(new.state_reason,''))) not between 1 and 500 then
   raise exception 'Transição SNCR proibida ou sem justificativa.' using errcode='23514';
  end if;
  if new.state='signed' and not exists(select 1 from public.digital_signatures
   where id=new.id and document_id=new.document_id and document_version=new.document_version
   and signed_pdf_hash=new.artifact_metadata->>'signed_pdf_hash' and status='SIGNED') then
   raise exception 'Estado final exige metadados de assinatura persistidos.' using errcode='23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
 end if;
 select * into d from public.clinical_documents where id=new.document_id for update;
 if not found or d.clinic_id is distinct from new.clinic_id or d.author_id is distinct from new.prescriber_id
   or d.version is distinct from new.document_version or d.kind is distinct from 'Receita'
   or d.status is null or d.status not in ('DRAFT','SIGNATURE_FAILED')
   or public.sncr_document_modality(d.text) is distinct from new.modality
   or d.text ~* '(^|\n)\s*(n[º°o]?\s*)?sncr:' then
  raise exception 'Reserva SNCR incompatível com o documento.' using errcode='23514';
 end if;
 select * into profile from public.document_profiles where clinic_id=new.clinic_id and user_id=new.prescriber_id for share;
 if not found or d.physician_registration is distinct from profile.physician_registration then
  raise exception 'Inscrição local incompatível com o documento.' using errcode='23514';
 end if;
 if not exists(select 1 from public.clinic_members where clinic_id=new.clinic_id and user_id=new.prescriber_id and role in ('owner','doctor')) then
  raise exception 'Prescritor não autorizado na clínica.' using errcode='42501';
 end if;
 select * into b from public.sncr_batches where id=new.batch_id for update;
 if not found or b.clinic_id is distinct from new.clinic_id or b.prescriber_id is distinct from new.prescriber_id
   or b.environment is distinct from new.environment or b.modality is distinct from new.modality
   or b.registration_snapshot is distinct from profile.physician_registration
   or not public.sncr_registration_matches(b.registration_snapshot,b.council,b.council_number,b.council_uf)
   or b.origin not in ('anvisa_api','synthetic') or b.verification_state<>'verified'
   or b.next_suffix<=b.first_suffix
   or new.number is distinct from (b.number_prefix||lpad((b.next_suffix-1)::text,b.suffix_width,'0'))
   or new.state is distinct from 'reserved' or new.state_reason is not null then
  raise exception 'Reserva SNCR incompatível com o lote e o cursor.' using errcode='23514';
 end if;
 perform 1 from public.sncr_requests where id=b.request_id and state='completed' for share;
 if not found then raise exception 'Requisição SNCR não concluída.' using errcode='23514'; end if;
 return new;
end $$;
create trigger sncr_reservation_integrity before insert or update or delete on public.sncr_reservations
 for each row execute function public.sncr_validate_reservation();

-- Um avanço do cursor só pode ser confirmado junto com a respectiva reserva.
-- O teste é adiado até o COMMIT; falha de qualquer parte desfaz tudo.
create function public.sncr_check_cursor_commit() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if new.next_suffix<>old.next_suffix and not exists(select 1 from public.sncr_reservations
  where batch_id=new.id and number=new.number_prefix||lpad(old.next_suffix::text,new.suffix_width,'0')) then
  raise exception 'Avanço SNCR sem reserva persistida.' using errcode='23514';
 end if;
 return null;
end $$;
create constraint trigger sncr_cursor_commit after update on public.sncr_batches
 deferrable initially deferred for each row execute function public.sncr_check_cursor_commit();

create function public.sncr_preserve_history() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 raise exception 'Histórico SNCR é imutável.' using errcode='23514';
end $$;
create trigger sncr_history_immutable before update or delete on public.sncr_operation_history
 for each row execute function public.sncr_preserve_history();

create function public.sncr_request_integrity() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if tg_op='DELETE' then raise exception 'Requisição SNCR deve ser conservada.' using errcode='23514'; end if;
 if (to_jsonb(new)-array['state','external_reference','updated_at']) is distinct from (to_jsonb(old)-array['state','external_reference','updated_at'])
  or (old.external_reference is not null and new.external_reference is distinct from old.external_reference) then
  raise exception 'Identidade da requisição SNCR é imutável.' using errcode='23514';
 end if;
 if new.state<>old.state and not (
  (old.state='pending' and new.state in ('completed','uncertain','failed','quarantined'))
  or (old.state='uncertain' and new.state in ('completed','quarantined'))
  or (old.state='completed' and new.state='quarantined')) then
  raise exception 'Transição de requisição SNCR proibida.' using errcode='23514';
 end if;
 new.updated_at := clock_timestamp();
 return new;
end $$;
create trigger sncr_request_immutable before update or delete on public.sncr_requests
 for each row execute function public.sncr_request_integrity();

create function public.sncr_record_operation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare req uuid; res uuid; action_name text; info jsonb;
begin
 if tg_table_name='sncr_requests' then
  if tg_op='UPDATE' and new.state=old.state and new.external_reference is not distinct from old.external_reference then return null; end if;
  req:=new.id; action_name:='request_'||new.state;
 elsif tg_table_name='sncr_batches' then
  if tg_op='UPDATE' and new.verification_state=old.verification_state then return null; end if;
  req:=new.request_id; action_name:='batch_'||new.verification_state;
 else
  if tg_op='UPDATE' and new.state=old.state and new.artifact_metadata is not distinct from old.artifact_metadata then return null; end if;
  res:=new.id; select request_id into req from public.sncr_batches where id=new.batch_id;
  action_name:='reservation_'||new.state;
 end if;
 info:=jsonb_build_object('environment',new.environment,'modality',new.modality,'db_session',session_user,'db_role',current_setting('role',true));
 if res is not null then info:=info||jsonb_build_object('document_id',new.document_id,'document_version',new.document_version,'reason',new.state_reason); end if;
 insert into public.sncr_operation_history(clinic_id,prescriber_id,request_id,reservation_id,action,details)
 values(new.clinic_id,new.prescriber_id,req,res,action_name,info);
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context)
 values(new.clinic_id,new.prescriber_id,'sncr.'||action_name,tg_table_name,new.id::text,info);
 return null;
end $$;
create trigger sncr_request_history after insert or update on public.sncr_requests for each row execute function public.sncr_record_operation();
create trigger sncr_batch_history after insert or update on public.sncr_batches for each row execute function public.sncr_record_operation();
create trigger sncr_reservation_history after insert or update on public.sncr_reservations for each row execute function public.sncr_record_operation();

-- O serviço deve obter usuário e clínica da sessão já validada; nunca aceitar
-- identidade, CRM ou documento profissional a partir de dados do navegador.
create function public.sncr_reserve_number(
 p_clinic uuid,p_prescriber uuid,p_document uuid,p_version integer,
 p_environment text,p_modality text,p_request_key uuid,p_synthetic boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; profile public.document_profiles; b public.sncr_batches;
 existing public.sncr_reservations; new_number text; new_id uuid;
begin
 if p_clinic is null or p_prescriber is null or p_document is null or p_request_key is null
    or p_synthetic is null or p_version is null or p_version<1 or p_environment is null or p_modality is null
    or p_environment not in ('hmg','prd') or p_modality not in ('controle_especial','retencao','notificacao_a','notificacao_b') then
  raise exception 'Parâmetros SNCR inválidos.' using errcode='22023';
 end if;
 if p_synthetic and (p_environment<>'hmg' or not exists(select 1 from public.sncr_local_sandboxes where clinic_id=p_clinic)) then
  raise exception 'Simulação exige clínica sintética isolada e ambiente hmg.' using errcode='42501';
 end if;
 if not exists(select 1 from public.clinic_members m where m.clinic_id=p_clinic and m.user_id=p_prescriber and m.role in ('owner','doctor')) then
  raise exception 'Prescritor não autorizado.' using errcode='42501';
 end if;
 select * into d from public.clinical_documents where id=p_document and clinic_id=p_clinic for update;
 if not found or d.author_id is distinct from p_prescriber or d.kind is distinct from 'Receita' or d.status is null or d.status not in ('DRAFT','SIGNATURE_FAILED') then
  raise exception 'Documento não pertence ao prescritor ou não pode receber numeração.' using errcode='42501';
 end if;
 select * into profile from public.document_profiles where clinic_id=p_clinic and user_id=p_prescriber for share;
 if not found or length(trim(coalesce(profile.physician_registration,'')))=0 or d.physician_registration is distinct from profile.physician_registration then
  raise exception 'Inscrição do documento não corresponde ao perfil do prescritor.' using errcode='42501';
 end if;
 if d.version is distinct from p_version then
  raise exception 'A receita foi alterada. Reabra o documento antes de reservar.' using errcode='40001';
 end if;
 if public.sncr_document_modality(d.text) is distinct from p_modality then
  raise exception 'Modalidade do documento incompatível com a reserva.' using errcode='42501';
 end if;
 -- Bloqueia chaves repetidas mesmo quando associadas a documentos diferentes.
 perform pg_advisory_xact_lock(hashtextextended(p_clinic::text || ':' || p_prescriber::text || ':' || p_request_key::text,0));
 select * into existing from public.sncr_reservations where (clinic_id=p_clinic and prescriber_id=p_prescriber and request_key=p_request_key) or document_id=p_document for update;
 if found then
  if existing.document_id<>p_document or existing.clinic_id<>p_clinic or existing.prescriber_id<>p_prescriber
    or existing.environment<>p_environment or existing.modality<>p_modality or existing.request_key<>p_request_key
    or existing.document_version<>p_version or existing.state<>'reserved'
    or not exists(select 1 from public.sncr_batches where id=existing.batch_id and origin=case when p_synthetic then 'synthetic' else 'anvisa_api' end) then
   raise exception 'Reserva anterior incompatível; reconciliação necessária.' using errcode='23505';
  end if;
  return jsonb_build_object('number',existing.number,'source','batch','reservationId',existing.id,'documentVersion',existing.document_version,'replayed',true);
 end if;
 select * into b from public.sncr_batches where clinic_id=p_clinic and prescriber_id=p_prescriber
  and environment=p_environment and modality=p_modality and origin=case when p_synthetic then 'synthetic' else 'anvisa_api' end and verification_state='verified'
  and exists (select 1 from public.sncr_requests r where r.id=sncr_batches.request_id and r.state='completed')
  and registration_snapshot=profile.physician_registration
  and public.sncr_registration_matches(registration_snapshot,council,council_number,council_uf) and next_suffix<=last_suffix
  order by created_at,id for update limit 1;
 if not found then raise exception 'Nenhum lote SNCR verificado disponível para este prescritor e ambiente.' using errcode='P0001'; end if;
 new_number := b.number_prefix || lpad(b.next_suffix::text,b.suffix_width,'0');
 update public.sncr_batches set next_suffix=next_suffix+1 where id=b.id;
 insert into public.sncr_reservations(batch_id,clinic_id,prescriber_id,document_id,document_version,environment,modality,request_key,number)
 values(b.id,p_clinic,p_prescriber,p_document,d.version,p_environment,p_modality,p_request_key,new_number) returning id into new_id;
 return jsonb_build_object('number',new_number,'source','batch','reservationId',new_id,'documentVersion',d.version,'replayed',false);
end $$;
revoke all on function public.sncr_reserve_number(uuid,uuid,uuid,integer,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.sncr_reserve_number(uuid,uuid,uuid,integer,text,text,uuid,boolean) to service_role;

-- Somente a RPC de reserva é exposta ao backend. Importação/admissão de lotes e
-- reconciliação de estados exigem fluxo confiável próprio nos próximos lotes.
revoke all on function public.sncr_check_batch_overlap(),public.sncr_document_modality(text),
 public.sncr_registration_matches(text,text,text,text),public.sncr_validate_reservation(),
 public.sncr_check_cursor_commit(),public.sncr_preserve_history(),public.sncr_request_integrity(),
 public.sncr_record_operation() from public,anon,authenticated,service_role;

-- Reserva congela a versão clínica; retificações exigem novo documento/número.
create function public.sncr_guard_document() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.sncr_reservations where document_id=old.id) then
  if tg_op='DELETE' then raise exception 'Documento com reserva SNCR deve ser conservado.' using errcode='23514'; end if;
  if (to_jsonb(new)-array['status','signed_pdf_path','updated_at']) is distinct from (to_jsonb(old)-array['status','signed_pdf_path','updated_at']) then
   raise exception 'Documento com reserva SNCR é imutável. Duplique como novo rascunho.' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
create trigger sncr_document_reserved before update or delete on public.clinical_documents for each row execute function public.sncr_guard_document();

-- Consulta sempre revalida a associação com o usuário interno, sem afirmar identidade Anvisa.
create function public.sncr_document_context(p_clinic uuid,p_prescriber uuid,p_document uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; r public.sncr_reservations; b public.sncr_batches;
begin
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic and user_id=p_prescriber and role in ('owner','doctor')) then
  raise exception 'Usuário não autorizado.' using errcode='42501';
 end if;
 select * into d from public.clinical_documents where id=p_document and clinic_id=p_clinic and author_id=p_prescriber;
 if not found then raise exception 'Documento não pertence ao prescritor.' using errcode='42501'; end if;
 select * into r from public.sncr_reservations where document_id=d.id;
 if found then
  select * into strict b from public.sncr_batches where id=r.batch_id;
  if r.clinic_id<>p_clinic or r.prescriber_id<>p_prescriber or r.document_version<>d.version
   or public.sncr_document_modality(d.text)<>r.modality or d.physician_registration<>b.registration_snapshot
   or not exists(select 1 from public.document_profiles where clinic_id=p_clinic and user_id=p_prescriber and physician_registration=b.registration_snapshot)
   or b.verification_state<>'verified' or not exists(select 1 from public.sncr_requests where id=b.request_id and state='completed') then
   raise exception 'Reserva inconsistente; reconciliação necessária.' using errcode='23514';
  end if;
 end if;
 return jsonb_build_object('document',to_jsonb(d),'reservation',case when r.id is null then null else to_jsonb(r) end,
  'origin',b.origin,'sandbox',exists(select 1 from public.sncr_local_sandboxes where clinic_id=p_clinic));
end $$;

create function public.sncr_reserve_document(p_clinic uuid,p_prescriber uuid,p_document uuid,p_request_key uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; context jsonb; existing public.sncr_reservations;
begin
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 if not (context->>'sandbox')::boolean then raise exception 'Emissão real bloqueada até o Lote 4.' using errcode='42501'; end if;
 select * into d from public.clinical_documents where id=p_document for update;
 select * into existing from public.sncr_reservations where document_id=d.id;
 if found then
  if existing.request_key<>p_request_key then raise exception 'Chave de reserva conflitante.' using errcode='23505'; end if;
  return public.sncr_document_context(p_clinic,p_prescriber,p_document);
 end if;
 if d.kind<>'Receita' or public.sncr_document_modality(d.text)='invalid' or d.text ~* '(^|\n)\s*(n[º°o]?\s*)?sncr:' then
  raise exception 'Número manual/histórico não verificado ou modalidade inválida.' using errcode='23514';
 end if;
 if d.document_date is null then
  update public.clinical_documents set document_date=(now() at time zone 'America/Sao_Paulo')::date,version=version+1 where id=d.id returning * into d;
 end if;
 perform public.sncr_reserve_number(p_clinic,p_prescriber,d.id,d.version,'hmg',public.sncr_document_modality(d.text),p_request_key,true);
 return public.sncr_document_context(p_clinic,p_prescriber,p_document);
end $$;

create function public.sncr_begin_signing(p_clinic uuid,p_prescriber uuid,p_document uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare context jsonb; r public.sncr_reservations;
begin
 perform 1 from public.clinical_documents where id=p_document for update;
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 if not coalesce((context->>'sandbox')::boolean,false) or context->>'origin' is distinct from 'synthetic' then
  raise exception 'Emissão real bloqueada até autenticação oficial.' using errcode='42501';
 end if;
 select * into r from public.sncr_reservations where document_id=p_document for update;
 if not found or r.environment<>'hmg' then raise exception 'Reserva sintética válida obrigatória.' using errcode='23514'; end if;
 if r.state='signed' then return context||jsonb_build_object('claimed',false); end if;
 if r.state<>'reserved' then raise exception 'Assinatura em andamento ou incerta; não repetir.' using errcode='40001'; end if;
 if context->'document'->>'status' not in ('DRAFT','SIGNATURE_FAILED') then raise exception 'Documento não disponível para assinatura.' using errcode='23514'; end if;
 update public.sncr_reservations set state='signing',state_reason='local_simulation_started',attempt_id=id where id=r.id;
 update public.clinical_documents set status='SIGNING' where id=p_document;
 return public.sncr_document_context(p_clinic,p_prescriber,p_document)||jsonb_build_object('claimed',true);
end $$;

-- Registra intenção/artefato ANTES do upload. Recuperação usa os mesmos bytes e
-- metadados; nunca pede nova assinatura por perda de uma resposta.
create function public.sncr_save_artifact(p_clinic uuid,p_prescriber uuid,p_document uuid,p_attempt uuid,p_metadata jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare context jsonb; r public.sncr_reservations; expected_path text;
begin
 perform 1 from public.clinical_documents where id=p_document for update;
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 select * into r from public.sncr_reservations where document_id=p_document for update;
 if not found or p_attempt is null or r.attempt_id is distinct from p_attempt or r.state not in ('signing','uncertain','signed') or context->>'origin' is distinct from 'synthetic' then
  raise exception 'Tentativa de assinatura incompatível.' using errcode='23514';
 end if;
 expected_path:=p_clinic::text||'/sncr-simulations/'||p_document::text||'_v'||r.document_version::text||'_'||p_attempt::text||'.pdf';
 if p_metadata is null or p_metadata->>'provider' is distinct from 'local_simulation'
  or p_metadata->>'signed_pdf_storage_path' is distinct from expected_path
  or coalesce(p_metadata->>'signed_pdf_hash','') !~ '^[a-f0-9]{64}$'
  or coalesce(p_metadata->>'unsigned_pdf_hash','') !~ '^[a-f0-9]{64}$'
  or coalesce(p_metadata->>'document_hash','') !~ '^[a-f0-9]{64}$' then
  raise exception 'Metadados do artefato simulado inválidos.' using errcode='23514';
 end if;
 if r.artifact_metadata is not null and r.artifact_metadata<>p_metadata then raise exception 'Artefato anterior não pode ser substituído.' using errcode='23505'; end if;
 update public.sncr_reservations set artifact_metadata=p_metadata where id=r.id;
 return public.sncr_document_context(p_clinic,p_prescriber,p_document);
end $$;

create function public.sncr_mark_uncertain(p_clinic uuid,p_prescriber uuid,p_document uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare context jsonb; r public.sncr_reservations;
begin
 perform 1 from public.clinical_documents where id=p_document for update;
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 select * into r from public.sncr_reservations where document_id=p_document for update;
 if not found or p_attempt is null or r.attempt_id is distinct from p_attempt then raise exception 'Tentativa incompatível.' using errcode='23514'; end if;
 if r.state='signing' then
  update public.sncr_reservations set state='uncertain',state_reason='local_simulation_result_unknown' where id=r.id;
  update public.clinical_documents set status='SIGNATURE_FAILED' where id=p_document and status='SIGNING';
 end if;
 return public.sncr_document_context(p_clinic,p_prescriber,p_document);
end $$;

create function public.sncr_finish_signing(p_clinic uuid,p_prescriber uuid,p_document uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare context jsonb; r public.sncr_reservations; metadata jsonb;
begin
 perform 1 from public.clinical_documents where id=p_document for update;
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 select * into r from public.sncr_reservations where document_id=p_document for update;
 if not found or p_attempt is null or r.attempt_id is distinct from p_attempt or r.state not in ('signing','uncertain','signed')
  or r.artifact_metadata is null or context->>'origin' is distinct from 'synthetic' then
  raise exception 'Conclusão de assinatura incompatível.' using errcode='23514';
 end if;
 if r.state='signed' then return context; end if;
 -- Somente o backend verifica o hash/assinatura dos bytes armazenados antes desta RPC.
 metadata:=r.artifact_metadata||jsonb_build_object('id',r.id,'clinic_id',p_clinic,'document_id',p_document,'document_version',r.document_version,
  'signer_user_id',p_prescriber,'signer_doctor_id',p_prescriber,'provider','local_simulation','status','SIGNED','verification_status','UNVERIFIED',
  'signature_format','PAdES-B-B','signed_at',now(),'created_at',now());
 insert into public.digital_signatures select (jsonb_populate_record(null::public.digital_signatures,metadata)).*;
 update public.clinical_documents set status='SIGNED',signed_pdf_path=metadata->>'signed_pdf_storage_path',updated_at=now() where id=p_document;
 update public.sncr_reservations set state='signed',state_reason='local_simulation_completed' where id=r.id;
 return public.sncr_document_context(p_clinic,p_prescriber,p_document);
end $$;

revoke all on function public.sncr_guard_document(),public.sncr_document_context(uuid,uuid,uuid),public.sncr_reserve_document(uuid,uuid,uuid,uuid),
 public.sncr_begin_signing(uuid,uuid,uuid),public.sncr_save_artifact(uuid,uuid,uuid,uuid,jsonb),
 public.sncr_mark_uncertain(uuid,uuid,uuid,uuid),public.sncr_finish_signing(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.sncr_document_context(uuid,uuid,uuid),public.sncr_reserve_document(uuid,uuid,uuid,uuid),
 public.sncr_begin_signing(uuid,uuid,uuid),public.sncr_save_artifact(uuid,uuid,uuid,uuid,jsonb),
 public.sncr_mark_uncertain(uuid,uuid,uuid,uuid),public.sncr_finish_signing(uuid,uuid,uuid,uuid) to service_role;

create function public.sncr_inventory(p_clinic uuid,p_prescriber uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic and user_id=p_prescriber and role in ('owner','doctor'))
 or not exists(select 1 from public.sncr_local_sandboxes where clinic_id=p_clinic) then raise exception 'Estoque sintético não autorizado.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'modality',b.modality,'label','SIMULAÇÃO LOCAL','total',b.last_suffix-b.first_suffix+1,'used',b.next_suffix-b.first_suffix,'remaining',b.last_suffix-b.next_suffix+1,'nextNumber',null,'inicio',b.number_prefix||lpad(b.first_suffix::text,b.suffix_width,'0'),'fim',b.number_prefix||lpad(b.last_suffix::text,b.suffix_width,'0'),'createdAt',b.created_at))
 from public.sncr_batches b join public.sncr_requests r on r.id=b.request_id
 where b.clinic_id=p_clinic and b.prescriber_id=p_prescriber and b.origin='synthetic' and b.environment='hmg' and b.verification_state='verified' and r.state='completed'),'[]'::jsonb);
end $$;
revoke all on function public.sncr_inventory(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sncr_inventory(uuid,uuid) to service_role;

-- Abandono local é terminal e conserva a numeração. Não representa devolução Anvisa.
create function public.sncr_abandon_document(p_clinic uuid,p_prescriber uuid,p_document uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare context jsonb; r public.sncr_reservations;
begin
 perform 1 from public.clinical_documents where id=p_document for update;
 context:=public.sncr_document_context(p_clinic,p_prescriber,p_document);
 select * into r from public.sncr_reservations where document_id=p_document for update;
 if context->>'origin' is distinct from 'synthetic' or not (context->>'sandbox')::boolean then raise exception 'Abandono restrito ao sandbox local.' using errcode='42501'; end if;
 if not found or p_reason is null or p_reason not in ('document_abandoned','replaced_by_new_document')
  or r.state not in ('reserved','uncertain','abandoned') or r.artifact_metadata is not null then
  raise exception 'Reserva exige reconciliação; abandono não autorizado.' using errcode='23514';
 end if;
 if r.state<>'abandoned' then update public.sncr_reservations set state='abandoned',state_reason=p_reason where id=r.id; end if;
 return public.sncr_document_context(p_clinic,p_prescriber,p_document);
end $$;
revoke all on function public.sncr_abandon_document(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sncr_abandon_document(uuid,uuid,uuid,text) to service_role;
