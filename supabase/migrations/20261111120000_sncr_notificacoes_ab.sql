-- Notificações de Receita A e B eletrônicas pelo mesmo passo a passo da RCE com numeração SNCR.
-- Os números vêm de sncr_numbering_items de um pedido NRA/NRB (o SNCR só entrega os que a
-- Vigilância Sanitária autorizou para emissão eletrônica). Aditiva: a RCE continua igual, e
-- emissões antigas ficam com category='RCE'. B2, retinoides e talidomida seguem fora.
alter table public.sncr_rce_emissions add column category text not null default 'RCE'
  check(category in ('RCE','NRA','NRB'));

create or replace function public.sncr_rce_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.snapshot is distinct from old.snapshot or new.snapshot_hash<>old.snapshot_hash or new.number<>old.number or
    new.environment<>old.environment or new.clinic_id<>old.clinic_id or new.user_id<>old.user_id or
    new.document_id<>old.document_id or new.document_version<>old.document_version or new.number_request_id<>old.number_request_id or
    new.category<>old.category then
  raise exception 'O conteúdo e a numeração reservados são imutáveis.';
 end if;
 if old.state='SIGNED' and new is distinct from old then raise exception 'O original assinado e seus metadados são imutáveis.'; end if;
 return new;
end $$;

-- Mesma assinatura da versão anterior (20261031010000). Agora o tipo de receituário vem do
-- documento, precisa bater com o conteúdo congelado e decide de qual lote sai o número.
create or replace function public.sncr_rce_reserve(eid uuid,c uuid,u uuid,did uuid,v integer,s jsonb,h text,env text default 'hmg')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.clinical_documents; e public.sncr_rce_emissions; n public.sncr_numbering_items; cat text;
begin
 if env not in ('hmg','prd') then raise exception 'Ambiente SNCR inválido.'; end if;
 select * into d from public.clinical_documents where id=did and clinic_id=c and author_id=u for update;
 if not found then raise insufficient_privilege; end if;
 select * into e from public.sncr_rce_emissions where id=eid;
 if found then
  if e.clinic_id<>c or e.user_id<>u or e.document_id<>did or e.snapshot_hash<>h or e.environment<>env then raise insufficient_privilege; end if;
  return to_jsonb(e);
 end if;
 cat:=coalesce(d.prescription_category,'RCE');
 if d.kind<>'Receita' or cat not in ('RCE','NRA','NRB') or d.status not in ('DRAFT','SIGNATURE_FAILED') or d.version<>v then
  raise exception 'A receita foi alterada ou já está em emissão. Reabra antes de continuar.';
 end if;
 -- O snapshot da RCE não traz categoria (mantém o hash das emissões antigas).
 if coalesce(s->>'category','RCE')<>cat then
  raise exception 'O conteúdo preparado não corresponde ao tipo de receituário. Reabra antes de continuar.';
 end if;
 if exists(select 1 from public.sncr_rce_emissions where document_id=did and state<>'CANCELLED') then raise exception 'Já existe uma emissão para esta receita.'; end if;
 select i.* into n from public.sncr_numbering_items i join public.sncr_numbering_requests r on r.id=i.request_id
 where i.clinic_id=c and i.user_id=u and i.environment=env and i.state='QUARANTINED'
 and r.category=cat and r.state='RECEIVED_UNVERIFIED' and r.input->>'conselho'='CRM'
 and r.input->>'documento'=s#>>'{prescriber,crm}' and r.input->>'uf'=s#>>'{prescriber,uf}'
 order by i.number limit 1 for update of i skip locked;
 if not found then
  raise exception '%', case
   when cat='RCE' and env='prd' then 'Sem numeração RCE disponível para seu CRM/UF. Conecte o SNCR e solicite um lote.'
   when cat='RCE' then 'Sem numeração RCE de teste disponível para seu CRM/UF. Conecte o SNCR e solicite um lote de homologação.'
   when env='prd' then 'Sem numeração de Notificação de Receita '||right(cat,1)||' disponível para seu CRM/UF. Peça à Vigilância Sanitária a numeração eletrônica e busque-a na página do SNCR.'
   else 'Sem numeração de teste de Notificação de Receita '||right(cat,1)||' para seu CRM/UF. Busque um lote de homologação na página do SNCR.' end;
 end if;
 update public.sncr_numbering_items set state='RESERVED' where environment=n.environment and number=n.number;
 if not exists(select 1 from public.sncr_numbering_items where request_id=n.request_id and state='QUARANTINED') then
  update public.sncr_numbering_requests set state='ALLOCATED',updated_at=now() where id=n.request_id;
 end if;
 insert into public.sncr_rce_emissions(id,clinic_id,user_id,document_id,document_version,environment,number,number_request_id,snapshot,snapshot_hash,category)
 values(eid,c,u,did,v,env,n.number,n.request_id,s,h,cat) returning * into e;
 return to_jsonb(e);
end $$;
revoke all on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.sncr_rce_reserve(uuid,uuid,uuid,uuid,integer,jsonb,text,text) to service_role;
notify pgrst,'reload schema';
