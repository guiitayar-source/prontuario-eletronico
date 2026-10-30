-- Receita simples: não é controlada e não depende do SNCR.
-- Depende de 20261019010000_sncr_preparation (coluna e guarda).
alter table public.clinical_documents drop constraint clinical_documents_prescription_category_check;
alter table public.clinical_documents add constraint clinical_documents_prescription_category_check
  check (prescription_category in ('SIMPLES','RCE','RET','NRA','NRB','NRB2','NRR','NRT'));

create or replace function public.sncr_document_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
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
     (tg_op='INSERT' or new.status is distinct from old.status) and
     new.prescription_category is distinct from 'SIMPLES' then
    if coalesce(new.prescription_category,'RCE')<>'RCE' or (now() at time zone 'America/Sao_Paulo')::date>='2026-10-30' then
      raise exception 'Emissão eletrônica indisponível: integração SNCR e modelo devem ser validados. Utilize a via física adequada.';
    end if;
  end if;
  return new;
end $$;
notify pgrst,'reload schema';
