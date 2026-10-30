-- SNCR 16 dígitos (30/10/2026): somente banco local até o teste completo em homologação.
do $$ begin
 raise exception 'Migração SNCR 16 dígitos em revisão: não aplicar';
end $$;

-- A homologação devolveu em 30/10/2026 a faixa RCE com sequência de 9 dígitos
-- (NNNN.N-NN.NNNNNNNNN), o formato de 16 dígitos anunciado pela Anvisa. O de 14
-- continua aceito. Quem decide o formato por categoria é o parser do servidor.
create or replace function public.sncr_store_numbers(rid uuid,c uuid,u uuid,numbers jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.sncr_numbering_requests; n text;
begin
  select * into r from public.sncr_numbering_requests where id=rid and clinic_id=c and user_id=u for update;
  if not found then raise insufficient_privilege; end if;
  if r.state<>'REQUESTING' or r.raw_response is null then raise exception 'Solicitação não está pronta para conferência.'; end if;
  if jsonb_typeof(numbers)<>'array' or jsonb_array_length(numbers) not between 1 and 1000 then raise exception 'Lote inválido.'; end if;
  for n in select jsonb_array_elements_text(numbers) loop
    if n!~'^[0-9]{4}\.[0-9]-[0-9]{2}\.([0-9]{7}|[0-9]{9})$' then raise exception 'Formato de numeração não validado.'; end if;
    insert into public.sncr_numbering_items(environment,number,request_id,clinic_id,user_id)
      values(r.environment,n,rid,c,u);
  end loop;
  update public.sncr_numbering_requests set state='RECEIVED_UNVERIFIED',updated_at=now() where id=rid;
end $$;

-- Reaproveita um retorno preservado (CONTRACT_REVIEW) sem nova chamada à Anvisa: devolve o
-- pedido a REQUESTING com o retorno bruto já gravado, para o servidor reler com o parser
-- atual e gravar por sncr_store_numbers. Se a releitura falhar, o servidor volta a
-- CONTRACT_REVIEW. Nada aqui altera raw_response.
create function public.sncr_reprocess_request(rid uuid,c uuid,u uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.sncr_numbering_requests;
begin
  select * into r from public.sncr_numbering_requests where id=rid and clinic_id=c and user_id=u for update;
  if not found then raise insufficient_privilege; end if;
  if r.state<>'CONTRACT_REVIEW' or r.raw_response is null then
    raise exception 'Só um retorno preservado para conferência pode ser reaproveitado.';
  end if;
  update public.sncr_numbering_requests set state='REQUESTING',updated_at=now() where id=rid;
  return to_jsonb(r);
end $$;
revoke all on function public.sncr_store_numbers(uuid,uuid,uuid,jsonb),public.sncr_reprocess_request(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sncr_store_numbers(uuid,uuid,uuid,jsonb),public.sncr_reprocess_request(uuid,uuid,uuid) to service_role;
