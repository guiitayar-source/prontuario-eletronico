-- Aplicação remota exige revisão própria. Testes aplicam somente uma cópia isolada.
do $$ begin
 raise exception 'Migração de permissões de assinatura em revisão: não aplicar';
end $$;

-- Atributos de confiança são escritos exclusivamente pelo backend.
-- Revoga também privilégios de coluna preexistentes; REVOKE da tabela não os remove.
do $$
declare target text; columns text; command text;
begin
 foreach target in array array['signature_sessions','signature_oauth_states','digital_signatures','evolution_signatures'] loop
  execute format('alter table public.%I enable row level security',target);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',target);
  select string_agg(quote_ident(attname),',') into columns
   from pg_attribute where attrelid=format('public.%I',target)::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on public.%I from public,anon,authenticated,service_role',columns,columns,columns,columns,target);
  -- Defesa adicional caso outro GRANT seja introduzido posteriormente.
  foreach command in array array['insert','update','delete'] loop
   execute format('drop policy if exists signature_server_%s on public.%I',command,target);
   execute format('create policy signature_server_%s on public.%I as restrictive for %s to anon,authenticated %s',
    command,target,command,case when command='insert' then 'with check (false)' when command='update' then 'using (false) with check (false)' else 'using (false)' end);
  end loop;
 end loop;
end $$;

drop policy if exists signature_sessions_owner on public.signature_sessions;
drop policy if exists signature_sessions_read on public.signature_sessions;
create policy signature_sessions_read on public.signature_sessions for select to authenticated
 using(user_id=auth.uid() and public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
-- A consulta de sessão existente filtra/ordena por estes campos. Nenhum ciphertext
-- ou certificado bruto é concedido ao navegador, nem mesmo ao próprio titular.
grant select(id,clinic_id,user_id,provider,cpf,certificate_alias,certificate_subject,certificate_issuer,
 certificate_valid_from,certificate_valid_to,expires_at,revoked,created_at)
 on public.signature_sessions to authenticated;

drop policy if exists signature_oauth_states_owner on public.signature_oauth_states;
drop policy if exists digital_signatures_insert on public.digital_signatures;
drop policy if exists digital_signatures_read on public.digital_signatures;
create policy digital_signatures_read on public.digital_signatures for select to authenticated
 using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[])
  and exists(select 1 from public.clinical_documents d where d.id=document_id and d.clinic_id=digital_signatures.clinic_id));
grant select on public.digital_signatures,public.evolution_signatures to authenticated;

-- OAuth cria/consome estados; sessões são substituídas por INSERT e revogadas por
-- UPDATE restrito. Metadados concluídos não possuem fluxo legítimo de UPDATE/DELETE.
grant select,insert on public.signature_sessions to service_role;
grant update(revoked,updated_at) on public.signature_sessions to service_role;
grant select,insert,delete on public.signature_oauth_states to service_role;
grant select,insert on public.digital_signatures,public.evolution_signatures to service_role;

-- Valida apenas novas assinaturas, preservando registros históricos. Não substitui
-- a verificação CMS/identidade do backend nem confere confiança ICP-Brasil.
-- SECURITY INVOKER: não oferece uma RPC privilegiada com parâmetros arbitrários.
create or replace function public.signature_metadata_document_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if not exists(select 1 from public.clinical_documents d
  join public.clinic_members m on m.clinic_id=d.clinic_id and m.user_id=d.author_id and m.role in ('owner','doctor')
  where d.id=new.document_id and d.clinic_id=new.clinic_id and d.version=new.document_version
   and d.author_id=new.signer_user_id and d.author_id=new.signer_doctor_id and d.status='SIGNING') then
  raise exception 'Vínculo da assinatura incompatível com o documento autorizado.' using errcode='23514';
 end if;
 return new;
end $$;
drop trigger if exists signature_metadata_document_preserved on public.digital_signatures;
create trigger signature_metadata_document_preserved before insert on public.digital_signatures
 for each row execute function public.signature_metadata_document_guard();
revoke all on function public.signature_metadata_document_guard() from public,anon,authenticated,service_role;

notify pgrst, 'reload schema';
