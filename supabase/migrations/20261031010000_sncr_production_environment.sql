-- SNCR em produção: a emissão de RCE passa a aceitar o ambiente 'prd' além de 'hmg'.
-- Só estende o que já existe. O servidor continua recusando qualquer ambiente que não esteja
-- em SNCR_ENVIRONMENT, então aplicar esta migração não liga nada sozinha.
alter table public.sncr_rce_emissions drop constraint sncr_rce_emissions_environment_check;
alter table public.sncr_rce_emissions add constraint sncr_rce_emissions_environment_check
  check(environment in ('hmg','prd'));

-- Antes: ambiente fixo 'hmg'. Agora o ambiente chega como argumento (padrão 'hmg', para o código
-- anterior continuar funcionando) e a reserva só sai de números do mesmo ambiente.
drop function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text);
create function public.sncr_rce_reserve(eid uuid,c uuid,u uuid,did uuid,v integer,s jsonb,h text,env text default 'hmg')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; e public.sncr_rce_emissions; n public.sncr_numbering_items; rid uuid;
begin
 if env not in ('hmg','prd') then raise exception 'Ambiente SNCR inválido.'; end if;
 select * into d from public.clinical_documents where id=did and clinic_id=c and author_id=u for update;
 if not found then raise insufficient_privilege; end if;
 select * into e from public.sncr_rce_emissions where id=eid;
 if found then
  if e.clinic_id<>c or e.user_id<>u or e.document_id<>did or e.snapshot_hash<>h or e.environment<>env then raise insufficient_privilege; end if;
  return to_jsonb(e);
 end if;
 if d.kind<>'Receita' or coalesce(d.prescription_category,'RCE')<>'RCE' or d.status not in ('DRAFT','SIGNATURE_FAILED') or d.version<>v then
  raise exception 'A receita foi alterada ou já está em emissão. Reabra antes de continuar.';
 end if;
 if exists(select 1 from public.sncr_rce_emissions where document_id=did and state<>'CANCELLED') then raise exception 'Já existe uma emissão para esta receita.'; end if;
 select i.* into n from public.sncr_numbering_items i join public.sncr_numbering_requests r on r.id=i.request_id
 where i.clinic_id=c and i.user_id=u and i.environment=env and i.state='QUARANTINED'
 and r.category='RCE' and r.state='RECEIVED_UNVERIFIED' and r.input->>'conselho'='CRM'
 and r.input->>'documento'=s#>>'{prescriber,crm}' and r.input->>'uf'=s#>>'{prescriber,uf}'
 order by i.number limit 1 for update of i skip locked;
 if not found then
  raise exception '%', case env
   when 'prd' then 'Sem numeração RCE disponível para seu CRM/UF. Conecte o SNCR e solicite um lote.'
   else 'Sem numeração RCE de teste disponível para seu CRM/UF. Conecte o SNCR e solicite um lote de homologação.' end;
 end if;
 update public.sncr_numbering_items set state='RESERVED' where environment=n.environment and number=n.number;
 if not exists(select 1 from public.sncr_numbering_items where request_id=n.request_id and state='QUARANTINED') then
  update public.sncr_numbering_requests set state='ALLOCATED',updated_at=now() where id=n.request_id;
 end if;
 insert into public.sncr_rce_emissions(id,clinic_id,user_id,document_id,document_version,environment,number,number_request_id,snapshot,snapshot_hash)
 values(eid,c,u,did,v,env,n.number,n.request_id,s,h) returning * into e;
 return to_jsonb(e);
end $$;
revoke all on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text,text) to service_role;

-- O caminho do original assinado carrega o ambiente da própria emissão (antes: sempre 'hmg').
create or replace function public.sncr_rce_finish(eid uuid,c uuid,u uuid,a uuid,p text,h text,t timestamptz,verification_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.sncr_rce_emissions;
begin
 select * into e from public.sncr_rce_emissions where id=eid and clinic_id=c and user_id=u for update;
 if not found then raise insufficient_privilege; end if;
 if e.state='SIGNED' then return to_jsonb(e); end if;
 if e.state<>'FINALIZING' or e.attempt_id is distinct from a or p not like c::text||'/sncr/'||e.environment||'/'||eid::text||'/%' or h!~'^[0-9a-f]{64}$' or verification_data->>'isValid'<>'true' then
   raise exception 'O original assinado ainda não foi validado e armazenado.';
 end if;
 update public.sncr_numbering_items set state='USED' where environment=e.environment and number=e.number and state='RESERVED';
 if not found then raise exception 'Número indisponível para concluir esta emissão.'; end if;
 update public.sncr_rce_emissions set state='SIGNED',signed_pdf_path=p,signed_pdf_hash=h,signed_at=t,verification=verification_data,updated_at=now() where id=eid returning * into e;
 return to_jsonb(e);
end $$;
