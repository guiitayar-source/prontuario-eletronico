-- Funções contratadas por clínica (plano). Só o titular altera, pelo script com a chave de
-- serviço (scripts/clinic-plan.mjs); a equipe apenas lê, para a tela esconder o que não faz
-- parte do plano. Fica fora de clinics porque o proprietário pode atualizar aquela linha.
create table public.clinic_features (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  features text[] not null default '{}'
    check (features <@ array['ia','anamnesator']::text[]),
  updated_at timestamptz not null default now()
);
alter table public.clinic_features enable row level security;
revoke all on public.clinic_features from anon, authenticated;
grant select on public.clinic_features to authenticated;
create policy clinic_features_read on public.clinic_features for select to authenticated
  using (public.has_clinic_role(clinic_id, array['owner','doctor','secretary']::public.clinic_role[]));

-- O Anamnesator grava pelo banco (anamnesator_request); a recusa fica aqui também para que
-- uma chamada direta, fora do aplicativo, não abra solicitações sem a função no plano.
create function public.anamnesator_requires_feature() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.clinic_features
                where clinic_id=new.clinic_id and 'anamnesator'=any(features)) then
    raise insufficient_privilege using message='O Anamnesator não faz parte do plano da clínica.';
  end if;
  return new;
end $$;
revoke all on function public.anamnesator_requires_feature() from public, anon, authenticated;
create trigger anamnesator_requires_feature before insert on public.anamnesator_requests
  for each row execute function public.anamnesator_requires_feature();

-- Clínicas que já existem continuam com tudo o que usam hoje; as novas começam sem nada.
insert into public.clinic_features(clinic_id, features)
  select id, array['ia','anamnesator'] from public.clinics
  on conflict (clinic_id) do nothing;
