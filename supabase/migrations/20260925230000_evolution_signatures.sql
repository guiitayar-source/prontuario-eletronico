-- Migração: Assinatura Digital ICP-Brasil em Evoluções Clínicas (Registros Nativos)
-- Criação de evolution_signatures, extensão de status em consultations e triggers de imutabilidade

-- 1. Extensão de colunas na tabela public.consultations
alter table public.consultations
  add column if not exists status text not null default 'DRAFT'
  check (status in ('DRAFT', 'FINALIZED', 'SIGNING', 'SIGNED', 'SIGNATURE_FAILED', 'SUPERSEDED'));

alter table public.consultations
  add column if not exists signed_at timestamptz;

alter table public.consultations
  add column if not exists signed_by uuid references auth.users(id);

alter table public.consultations
  add column if not exists current_signature_id uuid;

-- Atualiza status de consultas já finalizadas anteriormente
update public.consultations
  set status = 'FINALIZED'
  where finalized_at is not null and status = 'DRAFT';

-- 2. Tabela de assinaturas digitais de evoluções clínicas
create table if not exists public.evolution_signatures (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  evolution_id uuid not null references public.consultations(id) on delete restrict,
  evolution_version integer not null,
  signer_user_id uuid not null references auth.users(id) on delete restrict,
  doctor_id uuid not null references auth.users(id) on delete restrict,
  canonical_schema_version integer not null default 1,
  canonical_data jsonb not null,
  digest_algorithm text not null default 'SHA-256',
  document_hash text not null,
  signature_format text not null default 'CMS',
  signature_value text not null,
  certificate_subject text not null,
  certificate_issuer text not null,
  certificate_serial text not null,
  certificate_fingerprint text not null,
  certificate_not_before timestamptz not null,
  certificate_not_after timestamptz not null,
  provider text not null default 'birdid',
  provider_signature_id text,
  signed_at timestamptz not null default now(),
  verification_status text not null default 'VALID' check (verification_status in ('VALID', 'INVALID', 'UNVERIFIED')),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Adiciona foreign key em current_signature_id após criação da tabela
alter table public.consultations
  drop constraint if exists fk_consultation_current_signature;

alter table public.consultations
  add constraint fk_consultation_current_signature
  foreign key (current_signature_id) references public.evolution_signatures(id) on delete set null;

create index if not exists evolution_signatures_evolution_idx
  on public.evolution_signatures(clinic_id, evolution_id, created_at desc);

create index if not exists evolution_signatures_hash_idx
  on public.evolution_signatures(document_hash);

-- 3. Row Level Security (RLS) para evolution_signatures
alter table public.evolution_signatures enable row level security;
revoke all on public.evolution_signatures from anon, authenticated;
grant select on public.evolution_signatures to authenticated;

drop policy if exists evolution_signatures_read on public.evolution_signatures;
create policy evolution_signatures_read on public.evolution_signatures
  for select to authenticated
  using (public.has_clinic_role(clinic_id, array['owner','doctor']::public.clinic_role[]));

-- 4. Triggers de Imutabilidade Estrita no PostgreSQL (Engine Level)
create or replace function public.check_consultation_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'SIGNED' then
    if (
      new.text is distinct from old.text or
      new.patient_id is distinct from old.patient_id or
      new.clinic_id is distinct from old.clinic_id or
      new.author_id is distinct from old.author_id or
      new.created_at is distinct from old.created_at
    ) then
      raise exception 'Evolução clínica assinada digitalmente é imutável. Registre um adendo.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_consultation_immutable on public.consultations;
create trigger trg_check_consultation_immutable
  before update on public.consultations
  for each row execute function public.check_consultation_immutable();

create or replace function public.check_consultation_delete_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'SIGNED' then
    raise exception 'Evolução clínica assinada digitalmente não pode ser excluída.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_check_consultation_delete_immutable on public.consultations;
create trigger trg_check_consultation_delete_immutable
  before delete on public.consultations
  for each row execute function public.check_consultation_delete_immutable();

-- 5. Atualização da procedure consultation_write
create or replace function public.consultation_write(c uuid, action text, d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.consultations; a public.consultation_addenda; aid text; pid text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 if action='create' then
  aid := nullif(d->>'appointment_id',''); pid := d->>'patient_id';
  perform 1 from public.patients where clinic_id=c and id=pid for update;
  if not found then raise exception 'Paciente não encontrado.'; end if;
  if aid is not null then
   perform 1 from public.appointments where clinic_id=c and id=aid and patient_id=pid and status in ('scheduled','in_progress') for update;
   if not found then raise exception 'Agendamento indisponível.'; end if;
  end if;
  select * into r from public.consultations where clinic_id=c and (id=(d->>'id')::uuid or (aid is not null and appointment_id=aid));
  if found then
   if r.patient_id<>pid then raise exception 'Consulta de outro paciente.'; end if;
   return to_jsonb(r);
  end if;
  insert into public.consultations(id,clinic_id,patient_id,appointment_id,author_id,status) values((d->>'id')::uuid,c,pid,aid,auth.uid(),'DRAFT') returning * into r;
  if aid is not null then update public.appointments set status='in_progress',version=version+1,updated_at=now() where clinic_id=c and id=aid; end if;
 else
  select * into r from public.consultations where clinic_id=c and id=(d->>'id')::uuid for update;
  if not found then raise exception 'Consulta não encontrada.'; end if;
  if action='addendum' then
   if r.finalized_at is null and r.status <> 'SIGNED' then raise exception 'Finalize a consulta antes de adicionar um adendo.'; end if;
   select * into a from public.consultation_addenda where id=(d->>'addendum_id')::uuid;
   if found then
    if a.consultation_id<>r.id or a.author_id<>auth.uid() or a.text<>d->>'text' then raise exception 'Identificador de adendo já utilizado.'; end if;
    return to_jsonb(r);
   end if;
   insert into public.consultation_addenda(id,consultation_id,clinic_id,author_id,text) values((d->>'addendum_id')::uuid,r.id,c,auth.uid(),d->>'text');
   return to_jsonb(r);
  end if;
  if action not in ('save','finalize') then raise exception 'Operação inválida.'; end if;
  if r.author_id<>auth.uid() then raise insufficient_privilege; end if;
  if r.status = 'SIGNED' or r.finalized_at is not null then raise exception 'Consulta finalizada; registre um adendo.'; end if;
  if (d->>'version')::integer is distinct from r.version then raise exception 'Outra edição foi salva. Recarregue a consulta antes de continuar.'; end if;
  if action='finalize' and char_length(btrim(d->>'text'))=0 then raise exception 'Escreva a evolução antes de finalizar.'; end if;
  update public.consultations set
    text=d->>'text',
    version=version+1,
    updated_at=now(),
    status=case when action='finalize' then 'FINALIZED' else status end,
    finalized_at=case when action='finalize' then now() else finalized_at end,
    finalized_by=case when action='finalize' then auth.uid() else finalized_by end
  where id=r.id returning * into r;
  if action='finalize' and r.appointment_id is not null then update public.appointments set status='completed',version=version+1,updated_at=now() where clinic_id=c and id=r.appointment_id; end if;
 end if;
 return to_jsonb(r);
end $$;
