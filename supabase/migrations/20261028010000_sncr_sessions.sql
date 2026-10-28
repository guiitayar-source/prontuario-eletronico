-- Revisão/aplicação remota não autorizadas. Testes removem apenas este bloco de uma cópia.
do $$ begin
 raise exception 'Migração de sessões SNCR em revisão: não aplicar';
end $$;

create table public.sncr_login_attempts (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check(environment in ('hmg','prd')),
 state_hash text not null unique check(state_hash ~ '^[a-f0-9]{64}$'),
 binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
 session_hash text check(session_hash ~ '^[a-f0-9]{64}$'),
 profile_snapshot jsonb not null,
 status text not null check(status in ('pending','exchanging','completed','cancelled','failed','uncertain','expired')),
 reason text check(reason in ('unauthorized','forbidden','unavailable','uncertain','invalid_response','cancelled','identity_mismatch')),
 expires_at timestamptz not null default now()+interval '5 minutes',
 created_at timestamptz not null default now(),
 unique(environment,session_hash)
);
create index sncr_login_owner on public.sncr_login_attempts(clinic_id,user_id,environment,created_at desc);
create table public.sncr_user_sessions (
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check(environment in ('hmg','prd')),
 id uuid not null unique references public.sncr_login_attempts(id) on delete restrict,
 token_cipher text,
 profile_snapshot jsonb not null,
 identity_status text not null default 'unverified' check(identity_status='unverified'),
 status text not null check(status in ('connected','expired','disconnected','rejected','identity_mismatch')),
 expires_at timestamptz not null,
 primary key(clinic_id,user_id,environment),
 check((status='connected')=(token_cipher is not null))
);
create table public.sncr_session_events (
 id bigint generated always as identity primary key,
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete restrict,
 environment text not null check(environment in ('hmg','prd')),
 action text not null,
 occurred_at timestamptz not null default now()
);
alter table public.sncr_login_attempts enable row level security;
alter table public.sncr_user_sessions enable row level security;
alter table public.sncr_session_events enable row level security;
revoke all on public.sncr_login_attempts,public.sncr_user_sessions,public.sncr_session_events from public,anon,authenticated,service_role;
revoke all on sequence public.sncr_session_events_id_seq from public,anon,authenticated,service_role;

-- Única interface privilegiada. Rotas obtêm usuário/clínica da sessão PsyWrite, nunca do body.
-- Nenhuma ação promove JWT decodificado, CPF/CRM interno ou mock a identidade oficial.
create function public.sncr_auth_operation(p_clinic uuid,p_user uuid,p_environment text,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare a public.sncr_login_attempts; s public.sncr_user_sessions; profile jsonb; result jsonb; event text;
begin
 if p_clinic is null or p_user is null or p_environment is null or p_environment not in ('hmg','prd') then
  raise exception 'Contexto SNCR inválido.' using errcode='22023';
 end if;
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic and user_id=p_user and role in ('owner','doctor')) then
  raise exception 'Usuário não autorizado.' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('sncr-auth:'||p_clinic::text||':'||p_user::text||':'||p_environment,0));
 select jsonb_build_object('registration',physician_registration,'cpf',cpf) into profile
 from public.document_profiles where clinic_id=p_clinic and user_id=p_user for share;
 if profile is null then raise exception 'Preencha seu perfil profissional.' using errcode='23514'; end if;
 update public.sncr_login_attempts set status='expired' where clinic_id=p_clinic and user_id=p_user and environment=p_environment
  and status='pending' and expires_at<=clock_timestamp();
 update public.sncr_login_attempts set status='uncertain',reason='uncertain' where clinic_id=p_clinic and user_id=p_user and environment=p_environment
  and status='exchanging' and expires_at<=clock_timestamp();
 if found then insert into public.sncr_session_events(clinic_id,user_id,environment,action) values(p_clinic,p_user,p_environment,'exchange_expired_uncertain'); end if;
 update public.sncr_user_sessions set status='expired',token_cipher=null where clinic_id=p_clinic and user_id=p_user and environment=p_environment
  and status='connected' and expires_at<=clock_timestamp();
 if found then insert into public.sncr_session_events(clinic_id,user_id,environment,action) values(p_clinic,p_user,p_environment,'session_expired'); end if;
 update public.sncr_user_sessions set status='identity_mismatch',token_cipher=null where clinic_id=p_clinic and user_id=p_user and environment=p_environment
  and status='connected' and profile_snapshot is distinct from profile;
 if found then insert into public.sncr_session_events(clinic_id,user_id,environment,action) values(p_clinic,p_user,p_environment,'profile_mismatch'); end if;

 if p_action='start' then
  if coalesce(profile->>'registration','')='' then raise exception 'Inscrição profissional ausente.' using errcode='23514'; end if;
  update public.sncr_login_attempts set status='cancelled',reason='cancelled' where clinic_id=p_clinic and user_id=p_user and environment=p_environment and status in ('pending','exchanging');
  update public.sncr_user_sessions set status='disconnected',token_cipher=null where clinic_id=p_clinic and user_id=p_user and environment=p_environment;
  insert into public.sncr_login_attempts(id,clinic_id,user_id,environment,state_hash,binding_hash,profile_snapshot,status)
   values((p_data->>'id')::uuid,p_clinic,p_user,p_environment,p_data->>'state_hash',p_data->>'binding_hash',profile,'pending') returning * into a;
  result:=jsonb_build_object('id',a.id); event:='login_started';
 elsif p_action='claim' then
  select * into a from public.sncr_login_attempts where clinic_id=p_clinic and user_id=p_user and environment=p_environment
   and state_hash=p_data->>'state_hash' and binding_hash=p_data->>'binding_hash' for update;
  if not found or a.status<>'pending' or a.expires_at<=clock_timestamp() then
   raise exception 'Tentativa inválida, expirada ou já utilizada.' using errcode='42501';
  end if;
  if a.profile_snapshot is distinct from profile then raise exception 'Perfil alterado durante a autenticação.' using errcode='23514'; end if;
  if coalesce(p_data->>'session_hash','') !~ '^[a-f0-9]{64}$' then raise exception 'Retorno inválido.' using errcode='22023'; end if;
  update public.sncr_login_attempts set status='exchanging',session_hash=p_data->>'session_hash' where id=a.id;
  result:=jsonb_build_object('id',a.id); event:='token_exchange_started';
 elsif p_action in ('complete','fail') then
  select * into a from public.sncr_login_attempts where id=(p_data->>'id')::uuid and clinic_id=p_clinic and user_id=p_user and environment=p_environment for update;
  if not found or a.status<>'exchanging' or a.expires_at<=clock_timestamp() then raise exception 'Tentativa já encerrada ou expirada.' using errcode='42501'; end if;
  if p_action='fail' then
   update public.sncr_login_attempts set status=case when p_data->>'reason'='uncertain' then 'uncertain' when p_data->>'reason'='cancelled' then 'cancelled' else 'failed' end,reason=p_data->>'reason' where id=a.id;
   event:='token_exchange_failed';
  else
   if a.profile_snapshot is distinct from profile then raise exception 'Perfil incompatível.' using errcode='23514'; end if;
   if coalesce(p_data->>'token_cipher','') !~ '^v1\.[a-f0-9]{24}\.[a-f0-9]{32}\.[a-f0-9]+$' or
    (p_data->>'expires_at')::timestamptz is null or (p_data->>'expires_at')::timestamptz<=clock_timestamp() or
    (p_data->>'expires_at')::timestamptz>clock_timestamp()+interval '30 seconds' then raise exception 'Token inválido ou expirado.' using errcode='23514'; end if;
   insert into public.sncr_user_sessions(clinic_id,user_id,environment,id,token_cipher,profile_snapshot,status,expires_at)
    values(p_clinic,p_user,p_environment,a.id,p_data->>'token_cipher',profile,'connected',(p_data->>'expires_at')::timestamptz)
    on conflict(clinic_id,user_id,environment) do update set id=excluded.id,token_cipher=excluded.token_cipher,profile_snapshot=excluded.profile_snapshot,
     status='connected',expires_at=excluded.expires_at,identity_status='unverified';
   update public.sncr_login_attempts set status='completed' where id=a.id; event:='session_connected_unverified';
  end if;
  result:='{}'::jsonb;
 elsif p_action='disconnect' then
  update public.sncr_login_attempts set status='cancelled',reason='cancelled' where clinic_id=p_clinic and user_id=p_user and environment=p_environment and status in ('pending','exchanging');
  update public.sncr_user_sessions set status='disconnected',token_cipher=null where clinic_id=p_clinic and user_id=p_user and environment=p_environment;
  result:='{}'::jsonb; event:='session_disconnected_locally';
 elsif p_action='invalidate' then
  -- A resposta tardia de uma sessão antiga não invalida a sessão nova.
  update public.sncr_user_sessions set status='rejected',token_cipher=null where clinic_id=p_clinic and user_id=p_user and environment=p_environment and id=(p_data->>'id')::uuid;
  result:='{}'::jsonb; event:='session_rejected';
 elsif p_action in ('status','read') then
  select * into a from public.sncr_login_attempts where clinic_id=p_clinic and user_id=p_user and environment=p_environment order by created_at desc,id desc limit 1;
  select * into s from public.sncr_user_sessions where clinic_id=p_clinic and user_id=p_user and environment=p_environment;
  result:=jsonb_build_object('state',case when a.status in ('pending','exchanging') then a.status when a.status in ('failed','uncertain') and a.created_at>coalesce((select created_at from public.sncr_login_attempts where id=s.id),'-infinity'::timestamptz) then a.status
    when s.id is not null then s.status when a.status='expired' then 'expired' else 'disconnected' end,
   'environment',p_environment,'identityStatus','unverified','expiresAt',s.expires_at,'reason',a.reason);
  if p_action='read' then result:=result||jsonb_build_object('id',s.id,'token_cipher',s.token_cipher,'profile',s.profile_snapshot); end if;
 else raise exception 'Operação de sessão inválida.' using errcode='22023'; end if;
 if event is not null then
  insert into public.sncr_session_events(clinic_id,user_id,environment,action) values(p_clinic,p_user,p_environment,event);
 end if;
 return result;
end $$;
revoke all on function public.sncr_auth_operation(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.sncr_auth_operation(uuid,uuid,text,text,jsonb) to service_role;

create function public.sncr_session_event_immutable() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin raise exception 'Histórico de sessão SNCR imutável.' using errcode='23514'; end $$;
create trigger sncr_session_event_preserved before update or delete on public.sncr_session_events
 for each row execute function public.sncr_session_event_immutable();
revoke all on function public.sncr_session_event_immutable() from public,anon,authenticated,service_role;
