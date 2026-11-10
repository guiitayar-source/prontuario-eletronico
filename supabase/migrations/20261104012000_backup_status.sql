-- Metadados operacionais: nenhum caminho, senha, URI ou conteúdo do backup.
create table public.clinic_backup_events (
 id uuid primary key, clinic_id uuid not null references public.clinics(id),
 actor_id uuid references auth.users(id), kind text not null check(kind in ('verified','external_copy')),
 source text not null check(source in ('scheduled','owner_declaration')),
 backup_at timestamptz not null, occurred_at timestamptz not null default now(),
 verification_seconds integer check(verification_seconds between 0 and 604800),
 verified_event_id uuid, unique(clinic_id,id),
 foreign key(clinic_id,verified_event_id) references public.clinic_backup_events(clinic_id,id),
 check(backup_at <= occurred_at and occurred_at <= now()+interval '5 minutes'),
 check((kind='verified' and source='scheduled' and actor_id is null and verified_event_id is null and verification_seconds is not null)
    or (kind='external_copy' and source='owner_declaration' and actor_id is not null and verified_event_id is not null and verification_seconds is null))
);
create index clinic_backup_recent on public.clinic_backup_events(clinic_id,kind,backup_at desc);
alter table public.clinic_backup_events enable row level security;
revoke all on public.clinic_backup_events from public,anon,authenticated;
grant select on public.clinic_backup_events to authenticated;
grant select,insert on public.clinic_backup_events to service_role;
create policy clinic_backup_owner_read on public.clinic_backup_events for select to authenticated
 using(public.has_clinic_role(clinic_id,array['owner']::public.clinic_role[]));

create function public.backup_external_copy_write(c uuid,d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare verified public.clinic_backup_events; result public.clinic_backup_events; copied_at timestamptz;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner']::public.clinic_role[]) then raise insufficient_privilege; end if;
 copied_at:=(d->>'copied_at')::timestamptz;
 select * into verified from public.clinic_backup_events where clinic_id=c and id=(d->>'verified_event_id')::uuid and kind='verified';
 if not found then raise exception 'Backup verificado não encontrado.'; end if;
 if copied_at is null or copied_at<verified.occurred_at or copied_at>now() then raise exception 'Informe a data da cópia, após a verificação e até o momento atual.'; end if;
 insert into public.clinic_backup_events(id,clinic_id,actor_id,kind,source,backup_at,occurred_at,verified_event_id)
 values((d->>'id')::uuid,c,auth.uid(),'external_copy','owner_declaration',verified.backup_at,copied_at,verified.id)
 on conflict(id) do nothing returning * into result;
 if result.id is null then
  select * into result from public.clinic_backup_events where id=(d->>'id')::uuid and clinic_id=c and actor_id=auth.uid() and verified_event_id=verified.id and occurred_at=copied_at;
  if not found then raise exception 'Identificador já utilizado. Atualize o painel.'; end if;
 end if;
 return to_jsonb(result);
end $$;
revoke all on function public.backup_external_copy_write(uuid,jsonb) from public,anon;
grant execute on function public.backup_external_copy_write(uuid,jsonb) to authenticated;
create trigger backup_events_audit after insert on public.clinic_backup_events for each row execute function public.record_change();
