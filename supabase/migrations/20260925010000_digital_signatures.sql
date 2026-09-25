-- Migração: Assinatura Digital ICP-Brasil (Bird ID / PAdES)
-- Criação de tabelas, triggers de imutabilidade e políticas de segurança (RLS)

-- 1. Extensão e status na tabela de documentos clínicos
alter table public.clinical_documents 
  add column if not exists status text not null default 'DRAFT' 
  check (status in ('DRAFT', 'FINALIZED', 'SIGNING', 'SIGNED', 'SIGNATURE_FAILED', 'SUPERSEDED'));

alter table public.clinical_documents 
  add column if not exists signed_pdf_path text;

-- Adiciona CPF no perfil de documentos médicos se ainda não existir
alter table public.document_profiles 
  add column if not exists cpf text;

-- Trigger para garantir imutabilidade estrita de documentos finalizados ou assinados
create or replace function public.check_clinical_document_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status in ('FINALIZED', 'SIGNED', 'SUPERSEDED') then
    if (
      new.text is distinct from old.text or
      new.kind is distinct from old.kind or
      new.document_date is distinct from old.document_date or
      new.physician_name is distinct from old.physician_name or
      new.physician_registration is distinct from old.physician_registration or
      new.patient_name is distinct from old.patient_name
    ) then
      raise exception 'Documento assinado ou finalizado é imutável. Alterações clínicas exigem nova versão/retificação.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_clinical_document_immutable on public.clinical_documents;
create trigger trg_check_clinical_document_immutable
  before update on public.clinical_documents
  for each row execute function public.check_clinical_document_immutable();

-- 2. Tabela para sessões ativas de assinatura (OAuth signature_session)
create table if not exists public.signature_sessions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'birdid',
  access_token_encrypted text not null,
  token_type text not null default 'Bearer',
  scope text not null default 'signature_session',
  cpf text not null,
  certificate_alias text not null,
  certificate_subject text not null,
  certificate_issuer text not null,
  certificate_valid_from timestamptz not null,
  certificate_valid_to timestamptz not null,
  certificate_raw text,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signature_sessions_user_idx
  on public.signature_sessions(clinic_id, user_id);

create unique index if not exists signature_sessions_active_uidx
  on public.signature_sessions(clinic_id, user_id, provider)
  where (revoked = false);

-- 3. Tabela para controle temporário de State + PKCE
create table if not exists public.signature_oauth_states (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'birdid',
  state_hash text not null unique,
  code_verifier_encrypted text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists signature_oauth_states_state_hash_idx
  on public.signature_oauth_states(state_hash);

create index if not exists signature_oauth_states_expiry_idx
  on public.signature_oauth_states(expires_at);

-- 4. Tabela de auditoria e metadados de assinaturas digitais realizadas
create table if not exists public.digital_signatures (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  document_id uuid not null references public.clinical_documents(id) on delete restrict,
  document_version integer not null,
  signer_user_id uuid not null references auth.users(id) on delete restrict,
  signer_doctor_id uuid not null references auth.users(id) on delete restrict,
  provider text not null default 'birdid',
  certificate_subject text not null,
  certificate_issuer text not null,
  certificate_serial text not null,
  certificate_fingerprint text not null,
  cpf_from_certificate text not null,
  signature_algorithm text not null default 'SHA256withRSA',
  digest_algorithm text not null default 'SHA-256',
  signature_format text not null default 'PAdES-B-B',
  signed_at timestamptz not null default now(),
  document_hash text not null,
  unsigned_pdf_hash text not null,
  signed_pdf_hash text not null,
  signed_pdf_storage_path text not null,
  status text not null check (status in ('SIGNED', 'SIGNATURE_FAILED')),
  verification_status text not null check (verification_status in ('VALID', 'INVALID', 'UNVERIFIED')),
  provider_transaction_id text,
  created_at timestamptz not null default now()
);

create index if not exists digital_signatures_doc_idx
  on public.digital_signatures(clinic_id, document_id, created_at desc);

-- 5. Row Level Security (RLS)
alter table public.signature_sessions enable row level security;
alter table public.signature_oauth_states enable row level security;
alter table public.digital_signatures enable row level security;

-- Apenas médicos/proprietários da clínica podem acessar suas sessões
drop policy if exists signature_sessions_owner on public.signature_sessions;
create policy signature_sessions_owner on public.signature_sessions
  for all to authenticated
  using (
    user_id = auth.uid() and 
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  )
  with check (
    user_id = auth.uid() and 
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  );

drop policy if exists signature_oauth_states_owner on public.signature_oauth_states;
create policy signature_oauth_states_owner on public.signature_oauth_states
  for all to authenticated
  using (
    user_id = auth.uid() and 
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  )
  with check (
    user_id = auth.uid() and 
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  );

drop policy if exists digital_signatures_read on public.digital_signatures;
create policy digital_signatures_read on public.digital_signatures
  for select to authenticated
  using (
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  );

drop policy if exists digital_signatures_insert on public.digital_signatures;
create policy digital_signatures_insert on public.digital_signatures
  for insert to authenticated
  with check (
    signer_user_id = auth.uid() and 
    public.has_clinic_role(clinic_id, array['owner', 'doctor']::public.clinic_role[])
  );

grant select, insert, update, delete on public.signature_sessions to authenticated;
grant select, insert, update, delete on public.signature_oauth_states to authenticated;
grant select, insert on public.digital_signatures to authenticated;

-- Força recarga do cache do PostgREST
notify pgrst, 'reload schema';
