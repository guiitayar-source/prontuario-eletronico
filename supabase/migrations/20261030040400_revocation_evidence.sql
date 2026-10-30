-- LCR/OCSP usadas na emissão, identificadas pelo SHA-256 do DER. Dado público de AC, sem paciente.
-- Os bytes só são guardados quando servem de prova: respostas OCSP (poucos KB) e LCR que mostrou
-- revogação/suspensão (motivo de bloqueio). LCR que só confirmou "não revogado" fica com hash,
-- tamanho e datas: uma LCR posterior prova o mesmo, e a LCR de uma AC grande (~1 MB, a cada 6 h)
-- encheria o banco sem ganho (ver RELATORIO-6F2D.md).
create table public.revocation_evidence (
 sha256 text primary key check(sha256 ~ '^[a-f0-9]{64}$'),
 kind text not null check(kind in ('CRL','OCSP')),
 der bytea check(octet_length(der) between 1 and 4194304),
 byte_length integer not null check(byte_length between 1 and 4194304),
 issuer text check(length(issuer)<=1024),
 this_update timestamptz,
 next_update timestamptz,
 produced_at timestamptz,
 source_url text not null check(source_url ~ '^https?://' and length(source_url)<=2048),
 fetched_at timestamptz not null default now(),
 check(der is null or octet_length(der)=byte_length),
 check(kind='CRL' or der is not null)
);

-- Para qual certificado da cadeia (do signatário ou da TSA) cada evidência serviu e o resultado.
create table public.signing_revocation_evidence (
 id bigint generated always as identity primary key,
 clinic_id uuid not null references public.clinics on delete restrict,
 attempt_id uuid not null references public.document_signing_attempts on delete restrict,
 evidence_sha256 text not null references public.revocation_evidence on delete restrict,
 chain text not null check(chain in ('SIGNER','TSA')),
 certificate_role text not null check(certificate_role in ('SIGNER','SIGNER_CA','TSA_SIGNER','TSA_CA')),
 certificate_serial text not null check(certificate_serial ~ '^[A-Fa-f0-9]{1,128}$'),
 certificate_fingerprint text not null check(certificate_fingerprint ~ '^[A-Fa-f0-9:]{64,95}$'),
 result text not null check(result in ('GOOD','GOOD_AT_POE','REVOKED_BEFORE_POE','REVOKED_NO_POE','CERTIFICATE_HOLD','INDETERMINATE','INVALID_EVIDENCE','NOT_EVALUATED')),
 created_at timestamptz not null default now(),
 unique(attempt_id,evidence_sha256,certificate_fingerprint)
);
create index signing_revocation_evidence_attempt_idx on public.signing_revocation_evidence(clinic_id,attempt_id);
create index signing_revocation_evidence_sha_idx on public.signing_revocation_evidence(evidence_sha256);

alter table public.revocation_evidence enable row level security;
alter table public.signing_revocation_evidence enable row level security;
revoke all on public.revocation_evidence,public.signing_revocation_evidence from public,anon,authenticated,service_role;
revoke all on sequence public.signing_revocation_evidence_id_seq from public,anon,authenticated,service_role;
grant select on public.revocation_evidence,public.signing_revocation_evidence to authenticated,service_role;

create policy signing_revocation_evidence_read on public.signing_revocation_evidence for select to authenticated
 using (public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
-- A evidência em si só é visível a quem enxerga um vínculo dela na própria clínica.
create policy revocation_evidence_read on public.revocation_evidence for select to authenticated
 using (exists(select 1 from public.signing_revocation_evidence l where l.evidence_sha256=sha256
  and public.has_clinic_role(l.clinic_id,array['owner','doctor']::public.clinic_role[])));

-- Escrita só pelo backend (service_role), em nome de um médico da clínica e de uma tentativa dele.
-- Com bytes, o SHA-256 e o tamanho são recalculados aqui. Sem bytes (LCR que só confirmou "não
-- revogado"), hash, tamanho e datas são o registro do que foi conferido na emissão.
create function public.signing_revocation_evidence_write(
 p_clinic uuid,p_user uuid,p_attempt uuid,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.document_signing_attempts; item jsonb; bytes bytea; digest text; total bigint:=0;
 stored integer:=0; linked integer:=0; n integer; result text; size integer;
begin
 if p_clinic is null or p_user is null or p_attempt is null or jsonb_typeof(p_items)<>'array' or
  jsonb_array_length(p_items) not between 1 and 32 then
  raise exception 'Evidência de revogação inválida.' using errcode='22023';
 end if;
 perform 1 from public.clinic_members where clinic_id=p_clinic and user_id=p_user and role in ('owner','doctor');
 if not found then raise exception 'Usuário sem autorização médica.' using errcode='42501'; end if;
 select * into a from public.document_signing_attempts where id=p_attempt for share;
 if not found or a.clinic_id<>p_clinic or a.user_id<>p_user then
  raise exception 'Tentativa incompatível.' using errcode='42501';
 end if;
 if a.state not in ('EXTERNAL_STARTED','UNCERTAIN','ARTIFACT_RECEIVED','ARTIFACT_STORED','COMPLETED') then
  raise exception 'Tentativa sem artefato assinado.' using errcode='23514';
 end if;
 for item in select * from jsonb_array_elements(p_items) loop
  result:=coalesce(item->>'result','NOT_EVALUATED');
  bytes:=null;
  if item ? 'der' then
   begin
    bytes:=decode(item->>'der','base64');
   exception when others then
    raise exception 'Evidência de revogação inválida.' using errcode='22023';
   end;
   if bytes is null or octet_length(bytes) not between 1 and 4194304 then
    raise exception 'Evidência de revogação grande demais ou vazia.' using errcode='22023';
   end if;
   total:=total+octet_length(bytes);
   if total>8388608 then raise exception 'Evidência de revogação grande demais.' using errcode='22023'; end if;
   digest:=encode(sha256(bytes),'hex');
   size:=octet_length(bytes);
   if item->>'sha256' is distinct from digest or (item ? 'byte_length' and (item->>'byte_length')::integer<>size) then
    raise exception 'SHA-256 da evidência não confere.' using errcode='22023';
   end if;
  else
   -- Sem bytes só LCR que não mostrou revogação; OCSP e prova de bloqueio exigem o DER.
   if item->>'kind' is distinct from 'CRL' or result in ('REVOKED_BEFORE_POE','REVOKED_NO_POE','CERTIFICATE_HOLD') or
    coalesce(item->>'sha256','') !~ '^[a-f0-9]{64}$' then
    raise exception 'Evidência sem bytes não permitida para este resultado.' using errcode='22023';
   end if;
   digest:=item->>'sha256';
   size:=(item->>'byte_length')::integer;
  end if;
  insert into public.revocation_evidence(sha256,kind,der,byte_length,issuer,this_update,next_update,produced_at,source_url)
   values(digest,item->>'kind',bytes,size,left(item->>'issuer',1024),(item->>'this_update')::timestamptz,
    (item->>'next_update')::timestamptz,(item->>'produced_at')::timestamptz,item->>'source_url')
   on conflict (sha256) do update set der=excluded.der
    where public.revocation_evidence.der is null and excluded.der is not null
     and public.revocation_evidence.byte_length=excluded.byte_length;
  get diagnostics n=row_count; stored:=stored+n;
  insert into public.signing_revocation_evidence(clinic_id,attempt_id,evidence_sha256,chain,certificate_role,certificate_serial,certificate_fingerprint,result)
   values(p_clinic,p_attempt,digest,item->>'chain',item->>'certificate_role',item->>'certificate_serial',
    item->>'certificate_fingerprint',result)
   on conflict (attempt_id,evidence_sha256,certificate_fingerprint) do nothing;
  get diagnostics n=row_count; linked:=linked+n;
 end loop;
 return jsonb_build_object('stored',stored,'linked',linked);
end $$;
revoke all on function public.signing_revocation_evidence_write(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.signing_revocation_evidence_write(uuid,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
