-- All capture transitions are atomic, authenticated and bound to one clinic,
-- initiating user, patient and request. Original migration is immutable.
revoke insert, update, delete on public.device_sessions, public.capture_requests, public.attachments from authenticated;
revoke select on public.device_sessions from authenticated;
revoke insert, update, delete on public.clinic_members from authenticated;
revoke delete on public.patients, public.appointments from authenticated;
revoke insert on public.audit_events from authenticated;

create table public.pending_uploads (
  path text primary key,
  clinic_id uuid not null,
  request_id text not null,
  upload_id text not null,
  created_by uuid not null references auth.users(id),
  name text not null,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp','application/pdf')),
  size bigint not null check (size between 1 and 12582912),
  expires_at timestamptz not null default now() + interval '15 minutes',
  foreign key (clinic_id, request_id) references public.capture_requests(clinic_id, id)
);
alter table public.pending_uploads enable row level security;
revoke all on public.pending_uploads from anon, authenticated;

create or replace function public.capture_command(c uuid, action text, d jsonb default '{}', device_token text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  s public.device_sessions; r public.capture_requests; p public.patients;
  a public.attachments; u public.pending_uploads;
  sid text; rid text; tok text; new_path text; result jsonb;
begin
  if auth.uid() is null or not public.is_clinic_member(c) then
    raise insufficient_privilege using message = 'Acesso não autorizado.';
  end if;
  if action = 'connect' then
    select * into p from public.patients where clinic_id=c and id=d->>'patientId';
    if not found then raise exception 'Paciente não encontrado.'; end if;
    if coalesce(d->>'category','') not in ('exam','report','other') then raise exception 'Categoria inválida.'; end if;
    sid := gen_random_uuid()::text; tok := encode(gen_random_bytes(32),'hex');
    insert into public.device_sessions(id,clinic_id,created_by,token_hash,expires_at)
      values(sid,c,auth.uid(),encode(digest(tok,'sha256'),'hex'),now()+interval '2 hours') returning * into s;
    rid := gen_random_uuid()::text;
    insert into public.capture_requests(id,clinic_id,session_id,patient_id,patient_name,category,expires_at)
      values(rid,c,sid,p.id,p.name,d->>'category',now()+interval '15 minutes') returning * into r;
    return jsonb_build_object('id',sid,'token',tok,'expires_at',extract(epoch from s.expires_at)*1000,'request',to_jsonb(r));
  end if;

  if action in ('classify','delete','file') then
    select * into a from public.attachments where clinic_id=c and id=d->>'id' and patient_id=d->>'patientId' for update;
    if not found then raise exception 'Anexo não encontrado.'; end if;
    if action='classify' then
      if coalesce(d->>'category','') not in ('exam','report','other') then raise exception 'Categoria inválida.'; end if;
      update public.attachments set category=(d->>'category')::public.attachment_category where id=a.id;
    elsif action='delete' then
      delete from public.attachments where id=a.id;
    end if;
    return to_jsonb(a);
  end if;

  if action in ('complete','prepare','commit','abort') then
    rid := case when action='complete' then d->>'id' else d->>'requestId' end;
    select session_id into sid from public.capture_requests where id=rid and clinic_id=c;
  else sid := d->>'id'; end if;
  select * into s from public.device_sessions where id=sid and clinic_id=c and created_by=auth.uid() for update;
  if not found or s.revoked or s.expires_at<=now() then raise exception 'Conexão encerrada ou expirada. Conecte novamente.'; end if;
  if action in ('mobile','complete','prepare','commit','abort') and
    (device_token is null or length(device_token)<>64 or encode(digest(device_token,'sha256'),'hex')<>s.token_hash) then
    raise insufficient_privilege using message='Leia o QR code novamente.';
  end if;
  if action in ('pair','mobile') then
    if action='mobile' then update public.device_sessions set last_seen=now() where id=s.id; end if;
    select * into r from public.capture_requests where session_id=s.id and clinic_id=c order by created_at desc,id desc limit 1;
    return jsonb_build_object('id',s.id,'expires_at',extract(epoch from s.expires_at)*1000,
      'connected',coalesce(s.last_seen>now()-interval '15 seconds',false),'request',case when r.id is null then null else to_jsonb(r) end);
  elsif action='disconnect' then
    update public.device_sessions set revoked=true where id=s.id;
    update public.capture_requests set state='revoked' where session_id=s.id and state='pending';
    return jsonb_build_object('ok',true);
  elsif action='request' then
    select * into p from public.patients where clinic_id=c and id=d->>'patientId';
    if not found then raise exception 'Paciente não encontrado.'; end if;
    if coalesce(d->>'category','') not in ('exam','report','other') then raise exception 'Categoria inválida.'; end if;
    update public.capture_requests set state='revoked' where session_id=s.id and state='pending';
    insert into public.capture_requests(id,clinic_id,session_id,patient_id,patient_name,category,expires_at)
      values(gen_random_uuid()::text,c,s.id,p.id,p.name,d->>'category',now()+interval '15 minutes') returning * into r;
    return jsonb_build_object('request',to_jsonb(r));
  end if;
  select * into r from public.capture_requests where id=rid and clinic_id=c for update;
  if not found then raise exception 'Solicitação não encontrada.'; end if;
  if action='complete' and r.state='completed' then return jsonb_build_object('ok',true); end if;
  if r.state<>'pending' or r.expires_at<=now() then raise exception 'Solicitação encerrada ou expirada.'; end if;
  if action='complete' then
    update public.capture_requests set state='completed' where id=r.id;
    return jsonb_build_object('ok',true);
  end if;
  select * into a from public.attachments where id=d->>'uploadId' and clinic_id=c and request_id=r.id;
  if found then return jsonb_build_object('id',a.id,'alreadyReceived',true); end if;
  if action='prepare' then
    if coalesce(d->>'uploadId','') !~ '^[a-f0-9-]{36}$' or char_length(d->>'name') not between 1 and 160 then raise exception 'Arquivo inválido.'; end if;
    if (select count(*) from public.attachments where request_id=r.id)>=10 then raise exception 'Limite de 10 arquivos atingido.'; end if;
    -- Stable lease for a retry; never overwrite an already accepted object.
    select * into u from public.pending_uploads where request_id=r.id and upload_id=d->>'uploadId' and created_by=auth.uid() and expires_at>now() limit 1;
    if found then return to_jsonb(u); end if;
    if (select count(*) from public.pending_uploads where request_id=r.id and expires_at>now()) + (select count(*) from public.attachments where request_id=r.id)>=10 then raise exception 'Limite de envios em andamento atingido.'; end if;
    new_path := c::text || '/' || gen_random_uuid()::text;
    insert into public.pending_uploads(path,clinic_id,request_id,upload_id,created_by,name,mime,size)
      values(new_path,c,r.id,d->>'uploadId',auth.uid(),d->>'name',d->>'mime',(d->>'size')::bigint) returning * into u;
    return to_jsonb(u);
  elsif action in ('commit','abort') then
    select * into u from public.pending_uploads where path=d->>'path' and clinic_id=c and request_id=r.id and upload_id=d->>'uploadId' and created_by=auth.uid();
    if not found or u.expires_at<=now() then raise exception 'Envio expirado. Inicie outro envio.'; end if;
    if action='abort' then
      delete from public.pending_uploads where path=u.path;
      return jsonb_build_object('ok',true);
    end if;
    if (select count(*) from public.attachments where request_id=r.id)>=10 then raise exception 'Limite de 10 arquivos atingido.'; end if;
    if not exists(select 1 from storage.objects where bucket_id='clinical-files' and name=u.path and (metadata->>'size')::bigint=u.size) then raise exception 'Arquivo ainda não recebido ou tamanho diferente.'; end if;
    insert into public.attachments(id,clinic_id,request_id,patient_id,name,mime,size,storage_path)
      values(u.upload_id,c,r.id,r.patient_id,u.name,u.mime,u.size,u.path);
    delete from public.pending_uploads where path=u.path;
    return jsonb_build_object('id',u.upload_id);
  end if;
  raise exception 'Ação inválida.';
end;
$$;
revoke all on function public.capture_command(uuid,text,jsonb,text) from public;
grant execute on function public.capture_command(uuid,text,jsonb,text) to authenticated;

-- Pending objects are immutable. Readers can access accepted clinic files or
-- their own upload lease; guessing a clinic prefix is not sufficient.
create or replace function public.can_access_clinical_object(object_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.attachments a where a.storage_path=object_name and public.is_clinic_member(a.clinic_id))
 or exists(select 1 from public.pending_uploads u where u.path=object_name and u.created_by=auth.uid() and u.expires_at>now() and public.is_clinic_member(u.clinic_id));
$$;
create function public.can_upload_clinical_object(object_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.pending_uploads u join public.capture_requests r on r.id=u.request_id join public.device_sessions s on s.id=r.session_id
 where u.path=object_name and u.created_by=auth.uid() and public.is_clinic_member(u.clinic_id)
 and u.expires_at>now() and r.expires_at>now() and r.state='pending' and s.expires_at>now() and not s.revoked);
$$;
revoke all on function public.can_upload_clinical_object(text) from public;
grant execute on function public.can_upload_clinical_object(text) to authenticated;
drop policy clinical_files_insert_members on storage.objects;
drop policy clinical_files_update_members on storage.objects;
create policy clinical_files_insert_lease on storage.objects for insert to authenticated
with check(bucket_id='clinical-files' and public.can_upload_clinical_object(name));

-- Metadata audit is recorded by the database, not supplied by the browser.
create function public.record_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb;
begin
  row_data := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if auth.uid() is not null then
    insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
      values((row_data->>'clinic_id')::uuid,auth.uid(),lower(tg_op),tg_table_name,row_data->>'id');
  end if;
  return coalesce(new,old);
end;
$$;
revoke all on function public.record_change() from public;
create trigger patients_audit after insert or update or delete on public.patients for each row execute function public.record_change();
create trigger appointments_audit after insert or update or delete on public.appointments for each row execute function public.record_change();
create trigger attachments_audit after insert or update or delete on public.attachments for each row execute function public.record_change();
