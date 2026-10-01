-- Arquivamento de pacientes: some das listas, da busca e da agenda, sem excluir nada.
-- Só o proprietário arquiva ou restaura; a alteração passa pela auditoria de patients.
alter table public.patients add column archived_at timestamptz;

create or replace function public.guard_patient_archive()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.archived_at is distinct from old.archived_at
    and not public.has_clinic_role(new.clinic_id, array['owner']::public.clinic_role[]) then
    raise exception 'Somente o proprietário arquiva ou restaura pacientes.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger patients_guard_archive before update on public.patients
for each row execute function public.guard_patient_archive();
