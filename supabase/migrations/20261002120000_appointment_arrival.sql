-- Chegada do paciente: horário agendado com chegada registrada aparece como "Aguardando".
-- O status continua 'scheduled', então iniciar a consulta (consultation_write) não muda.
alter table public.appointments add column arrived_at timestamptz;
