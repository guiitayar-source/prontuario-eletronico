-- Libera a RET eletrônica (fluxo e PDF próprios) até o fim da transição SNCR. Depende de
-- 20261030030624_sncr_transition_extension (main), que define public.sncr_transition_end().
-- Muda só a condição de categoria em relação àquela versão de sncr_document_guard.

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
  -- RCE e RET eletrônicas sem integração SNCR: só até o fim da transição. Notificações seguem
  -- bloqueadas até a integração estar operando. Receita simples não depende do SNCR.
  if new.kind='Receita' and new.status in ('SIGNING','SIGNED') and
     (tg_op='INSERT' or new.status is distinct from old.status) and
     new.prescription_category is distinct from 'SIMPLES' then
    if coalesce(new.prescription_category,'RCE') not in ('RCE','RET') or
       (now() at time zone 'America/Sao_Paulo')::date>=public.sncr_transition_end() then
      raise exception 'Emissão eletrônica indisponível: integração SNCR e modelo devem ser validados. Utilize a via física adequada.';
    end if;
  end if;
  return new;
end $$;
