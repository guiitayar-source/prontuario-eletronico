-- Aplicação remota exige revisão própria. Somente cópia em PostgreSQL descartável.
do $$ begin
 raise exception 'Migração OAuth de assinatura em revisão: não aplicar';
end $$;

alter table public.signature_oauth_states
 add column if not exists status text not null default 'pending',
 add column if not exists browser_binding_hash text,
 add column if not exists auth_session_id uuid,
 add column if not exists claimed_at timestamptz,
 add column if not exists completed_at timestamptz,
 add column if not exists outcome text,
 add column if not exists result_session_id uuid;
-- Tentativas antigas não possuem prova de origem. Nunca as promover ao novo fluxo.
update public.signature_oauth_states set status='rejected',outcome='legacy_context',code_verifier_encrypted=''
 where status='pending' and (browser_binding_hash is null or auth_session_id is null);
alter table public.signature_oauth_states drop constraint if exists signature_oauth_status;
alter table public.signature_oauth_states add constraint signature_oauth_status
 check(status in ('pending','processing','completed','expired','rejected','uncertain'));

-- Preserva as negações RLS do 6C. Novas colunas não recebem privilégios frontend.
revoke all on public.signature_oauth_states from public,anon,authenticated,service_role;
-- Inspeção pelo backend; todas as mutações do fluxo passam pela RPC abaixo.
grant select on public.signature_oauth_states to service_role;

create or replace function public.signature_oauth_operation(
 p_action text,p_clinic_id uuid,p_user_id uuid,p_auth_session_id uuid,
 p_state_hash text,p_binding_hash text,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $$
declare a public.signature_oauth_states; s public.signature_sessions; profile public.document_profiles;
 v_verifier text; v_cpf text; v_reason text; v_session_ok boolean;
begin
 if p_action is null or p_clinic_id is null or p_user_id is null or p_action not in ('start','claim','finish','reject','uncertain') or
    p_state_hash !~ '^[a-f0-9]{64}$' or p_binding_hash !~ '^[a-f0-9]{64}$' or
    p_state_hash is null or p_binding_hash is null or p_auth_session_id is null then
  raise exception 'Contexto OAuth inválido.' using errcode='22023';
 end if;
 -- Serializa conclusões independentes do mesmo usuário, inclusive entre clínicas.
 -- Nenhuma operação externa é feita dentro desta transação.
 perform pg_advisory_xact_lock(hashtextextended('psc-user:'||p_user_id::text,0));
 if p_action='start' then
  perform 1 from public.clinic_members where clinic_id=p_clinic_id and user_id=p_user_id and role in ('owner','doctor') for share;
  if not found then
   raise exception 'Usuário não autorizado.' using errcode='42501';
  end if;
  perform 1 from auth.sessions where id=p_auth_session_id and user_id=p_user_id and (not_after is null or not_after>now()) for share;
  if not found then raise exception 'Sessão PsyWrite inválida.' using errcode='42501'; end if;
  if coalesce(p_payload->>'provider','') not in ('birdid','vidaas') or
     coalesce(p_payload->>'redirect_uri','')='' or coalesce(p_payload->>'verifier','')='' then
   raise exception 'Tentativa inválida.' using errcode='22023';
  end if;
  insert into public.signature_oauth_states(clinic_id,user_id,provider,state_hash,code_verifier_encrypted,redirect_uri,expires_at,browser_binding_hash,auth_session_id)
   values(p_clinic_id,p_user_id,p_payload->>'provider',p_state_hash,p_payload->>'verifier',p_payload->>'redirect_uri',now()+interval '5 minutes',p_binding_hash,p_auth_session_id) returning * into a;
 else
  select * into a from public.signature_oauth_states where state_hash=p_state_hash for update;
  if not found or a.clinic_id<>p_clinic_id or a.user_id<>p_user_id or
     a.auth_session_id is distinct from p_auth_session_id or a.browser_binding_hash is distinct from p_binding_hash then
   return jsonb_build_object('status','invalid');
  end if;
  if a.status='processing' and a.expires_at<=now() then
   update public.signature_oauth_states set status='uncertain',outcome='processing_expired',code_verifier_encrypted='' where id=a.id returning * into a;
  elsif a.status='pending' and a.expires_at<=now() then
   update public.signature_oauth_states set status='expired',outcome='expired',code_verifier_encrypted='' where id=a.id returning * into a;
  end if;
  if (p_action='claim' and a.status<>'pending') or (p_action<>'claim' and a.status<>'processing') then
   return jsonb_build_object('status','unavailable','attempt_status',a.status);
  end if;
  -- Confere novamente no COMMIT da sessão. Logout ou remoção do papel durante HTTP bloqueiam resposta tardia.
  perform 1 from auth.sessions where id=p_auth_session_id and user_id=p_user_id and (not_after is null or not_after>now()) for share;
  v_session_ok:=found;
  perform 1 from public.clinic_members where clinic_id=p_clinic_id and user_id=p_user_id and role in ('owner','doctor') for share;
  if not found or not v_session_ok then
   update public.signature_oauth_states set status='rejected',outcome='authorization_lost',code_verifier_encrypted='' where id=a.id;
   return jsonb_build_object('status','rejected','reason','authorization_lost');
  end if;
  if p_action='claim' then
   if a.redirect_uri is distinct from p_payload->>'redirect_uri' then return jsonb_build_object('status','invalid'); end if;
   v_verifier:=a.code_verifier_encrypted;
   update public.signature_oauth_states set status='processing',claimed_at=now(),code_verifier_encrypted='' where id=a.id returning * into a;
  elsif p_action in ('reject','uncertain') then
   v_reason:=case when p_payload->>'reason' in ('cancelled','invalid_code','external_failure','certificate_identity_unavailable','certificate_profile_identity_mismatch','prior_certificate_mismatch','local_failure') then p_payload->>'reason' else 'external_failure' end;
   update public.signature_oauth_states set status=case when p_action='reject' then 'rejected' else 'uncertain' end,outcome=v_reason where id=a.id returning * into a;
  elsif p_action='finish' then
   v_cpf:=p_payload->>'cpf';
   if coalesce(v_cpf,'') !~ '^[0-9]{11}$' or coalesce(p_payload->>'certificate_raw','')='' or coalesce(p_payload->>'access_token_encrypted','')='' or
      (p_payload->>'expires_at')::timestamptz<=now() then
    raise exception 'Identidade incompleta.' using errcode='22023';
   end if;
   insert into public.document_profiles(clinic_id,user_id,physician_name,physician_registration)
    values(p_clinic_id,p_user_id,coalesce(p_payload->>'common_name',''),'') on conflict(clinic_id,user_id) do nothing;
   select * into profile from public.document_profiles where clinic_id=p_clinic_id and user_id=p_user_id for update;
   -- CPF do perfil é somente uma conferência. A identidade anterior de certificado
   -- também ancora o vínculo: editar o perfil não autoriza substituir outro titular.
   if (nullif(profile.cpf,'') is not null and regexp_replace(profile.cpf,'[^0-9]','','g')<>v_cpf) or
      exists(select 1 from public.signature_sessions where user_id=p_user_id and cpf<>v_cpf) or
      coalesce((p_payload->>'prior_certificate_mismatch')::boolean,false) then
    update public.signature_sessions set revoked=true where user_id=p_user_id and revoked=false;
    update public.signature_oauth_states set status='rejected',outcome='certificate_profile_identity_mismatch' where id=a.id returning * into a;
   else
    update public.document_profiles set cpf=v_cpf where clinic_id=p_clinic_id and user_id=p_user_id and nullif(cpf,'') is null;
    -- Nova autorização explícita substitui as antigas, inclusive legadas sem certificado.
    update public.signature_sessions set revoked=true where user_id=p_user_id and clinic_id=p_clinic_id and revoked=false;
    insert into public.signature_sessions(clinic_id,user_id,provider,cpf,certificate_alias,certificate_subject,certificate_issuer,certificate_valid_from,certificate_valid_to,certificate_raw,access_token_encrypted,expires_at)
     values(p_clinic_id,p_user_id,a.provider,v_cpf,p_payload->>'certificate_alias',p_payload->>'certificate_subject',p_payload->>'certificate_issuer',
      (p_payload->>'certificate_valid_from')::timestamptz,(p_payload->>'certificate_valid_to')::timestamptz,p_payload->>'certificate_raw',p_payload->>'access_token_encrypted',(p_payload->>'expires_at')::timestamptz) returning * into s;
    update public.signature_oauth_states set status='completed',completed_at=now(),outcome='connected',result_session_id=s.id where id=a.id returning * into a;
   end if;
  end if;
 end if;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context)
  values(p_clinic_id,p_user_id,'signature_oauth_'||a.status,'signature_oauth_attempt',a.id,jsonb_build_object('provider',a.provider,'reason',a.outcome));
 return jsonb_build_object('status',a.status,'id',a.id,'provider',a.provider,'redirect_uri',a.redirect_uri,'verifier',v_verifier,'reason',a.outcome,
  'session',case when s.id is null then null else to_jsonb(s)-'access_token_encrypted'-'certificate_raw' end);
end $$;
revoke all on function public.signature_oauth_operation(text,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.signature_oauth_operation(text,uuid,uuid,uuid,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
