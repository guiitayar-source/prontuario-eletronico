-- Aplicação remota exige revisão própria. Testes aplicam somente uma cópia isolada.
do $$ begin
 raise exception 'Migração de identidade de assinatura em revisão: não aplicar';
end $$;

-- A identidade autorizada se refere à versão congelada antes da chamada ao HSM.
-- Não altera os vínculos, estados ou bloqueios transacionais do SNCR.
create function public.signature_document_identity_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
 if old.status in ('SIGNING','SIGNED') then
  if tg_op='DELETE' then
   raise exception 'Documento em assinatura ou assinado deve ser conservado.' using errcode='23514';
  end if;
  if (to_jsonb(new)-array['status','signed_pdf_path','updated_at']) is distinct from
     (to_jsonb(old)-array['status','signed_pdf_path','updated_at']) then
   raise exception 'Identidade e versão do documento em assinatura são imutáveis.' using errcode='23514';
  end if;
  if old.status='SIGNED' and (new.signed_pdf_path is distinct from old.signed_pdf_path or new.status not in ('SIGNED','SUPERSEDED')) then
   raise exception 'Assinatura concluída não pode ser substituída ou reiniciada.' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
create trigger signature_document_identity_preserved before update or delete on public.clinical_documents
 for each row execute function public.signature_document_identity_guard();
revoke all on function public.signature_document_identity_guard() from public,anon,authenticated,service_role;
