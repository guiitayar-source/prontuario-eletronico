-- Rename the internal implementation; only its authenticated wrapper and the
-- trusted server can call it. Browser users cannot bypass content validation.
alter function public.capture_command(uuid,text,jsonb,text) rename to capture_internal;
revoke all on function public.capture_internal(uuid,text,jsonb,text) from authenticated, public, anon;
create function public.capture_command(c uuid, action text, d jsonb default '{}', device_token text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if action='commit' then raise insufficient_privilege using message='Validação do servidor necessária.'; end if;
  return public.capture_internal(c,action,d,device_token);
end;
$$;
revoke all on function public.capture_command(uuid,text,jsonb,text) from public;
grant execute on function public.capture_command(uuid,text,jsonb,text) to authenticated;
create function public.commit_verified_upload(c uuid, d jsonb, actor uuid, device_token text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor::text,'role','service_role')::text,true);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  return public.capture_internal(c,'commit',d,device_token);
end;
$$;
revoke all on function public.commit_verified_upload(uuid,jsonb,uuid,text) from public, anon, authenticated;
grant execute on function public.commit_verified_upload(uuid,jsonb,uuid,text) to service_role;
