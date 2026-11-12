// Horário da agenda e as contas de data, hora e duração que a lista do dia e o formulário
// de horário usam.
export type Appointment = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_social_name: string | null;
  starts_at: number;
  ends_at: number;
  modality: 'presencial' | 'teleconsulta';
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  arrived_at: number | null;
  admin_notes: string | null;
  version: number;
};

type Situation = 'scheduled' | 'waiting' | 'in_progress' | 'completed' | 'no_show' | 'unrecorded';

export const SITUATION_LABEL: Record<Situation, string> = {
  scheduled: 'Agendado',
  waiting: 'Aguardando',
  in_progress: 'Em atendimento',
  completed: 'Finalizado',
  no_show: 'Faltou',
  unrecorded: 'Sem registro',
};

/** Situação mostrada: "aguardando" é um agendado com chegada; dia passado sem nada é "sem registro". */
export const situationOf = (item: Appointment, past: boolean): Situation => {
  if (item.status !== 'scheduled') return item.status as Situation;
  if (item.arrived_at) return 'waiting';
  return past ? 'unrecorded' : 'scheduled';
};

export const clock = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

export const displayDate = (day: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00`));

export const dateInput = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};

export const localDateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

// Duração padrão da consulta, guardada no navegador de quem agenda.
export const DURATION_KEY = 'psywrite-appointment-duration';
export const MIN_DURATION = 10;
export const MAX_DURATION = 480;
export const validDuration = (minutes: number) =>
  Number.isInteger(minutes) &&
  minutes >= MIN_DURATION &&
  minutes <= MAX_DURATION;

export const storedDuration = () => {
  try {
    const value = Number(localStorage.getItem(DURATION_KEY));
    return validDuration(value) ? value : 50;
  } catch {
    return 50; // localStorage indisponível
  }
};

export const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** Hora de término (HH:MM) para um início "AAAA-MM-DDTHH:MM" e uma duração. */
export const endTime = (start: string, duration: number) => {
  const total = (minutesOf(start.slice(11, 16)) + duration) % 1440;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};
