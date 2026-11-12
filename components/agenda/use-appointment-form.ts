// Lógica do formulário de horário (novo ou edição): busca do paciente, início, término,
// duração padrão e o envio para o servidor. A tela está em appointment-form.tsx.
import { apiFetch as fetch } from '@/lib/supabase/http';
import { useEffect, useRef, useState } from 'react';
import type { Patient } from '@/lib/patient-fields';
import {
  DURATION_KEY,
  endTime,
  localDateTime,
  minutesOf,
  storedDuration,
  validDuration,
  type Appointment,
} from './appointment';

export type AppointmentFormProps = {
  day: string;
  appointment: Appointment | null;
  onClose: () => void;
  onSaved: () => void;
};

/** Estado e ações do formulário de horário. Ao salvar, avisa a agenda e fecha. */
export function useAppointmentForm({
  day,
  appointment,
  onClose,
  onSaved,
}: AppointmentFormProps) {
  const defaultStart = `${day}T09:00`;
  const newId = useRef(crypto.randomUUID());
  const [query, setQuery] = useState(
    appointment?.patient_social_name || appointment?.patient_name || '',
  );
  const [matches, setMatches] = useState<Patient[]>([]);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [start, setStart] = useState(
    appointment ? localDateTime(appointment.starts_at) : defaultStart,
  );
  const [duration, setDuration] = useState(storedDuration);
  const [durationInput, setDurationInput] = useState(String(duration));
  // O término é só a hora: o dia é sempre o do início.
  const [end, setEnd] = useState(() =>
    appointment
      ? localDateTime(appointment.ends_at).slice(11, 16)
      : endTime(defaultStart, duration),
  );
  const [modality, setModality] = useState<string>(
    appointment?.modality || 'presencial',
  );
  const [notes, setNotes] = useState(appointment?.admin_notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (appointment) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (query.trim().length < 2) return setMatches([]);
      try {
        const result = await fetch(
          `/api/patients?q=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        const data = (await result.json()) as { patients?: Patient[] };
        if (result.ok) setMatches(data.patients || []);
      } catch {
        /* Preserve the current form. */
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, appointment]);

  function changeStart(value: string) {
    setStart(value);
    if (!value) return;
    // Num horário novo vale a duração padrão; ao remarcar, mantém a duração atual.
    const current =
      (minutesOf(end) - minutesOf(start.slice(11, 16)) + 1440) % 1440;
    setEnd(endTime(value, appointment && current ? current : duration));
  }

  function changeDuration(value: string) {
    setDurationInput(value);
    const minutes = Number(value);
    if (!validDuration(minutes)) return;
    setDuration(minutes);
    if (start) setEnd(endTime(start, minutes));
    try {
      localStorage.setItem(DURATION_KEY, String(minutes));
    } catch {
      /* Vale só nesta janela. */
    }
  }

  async function save(event: React.SubmitEvent) {
    event.preventDefault();
    const selected =
      patient || (appointment ? { id: appointment.patient_id } : null);
    if (!selected)
      return setError('Clique no nome do paciente na lista para selecioná-lo.');
    const startsAt = new Date(start).getTime();
    const endsAt = new Date(`${start.slice(0, 10)}T${end}`).getTime();
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt))
      return setError('Informe data e horários válidos.');
    if (endsAt <= startsAt)
      return setError('O término deve ser depois do início, no mesmo dia.');
    setBusy(true);
    setError('');
    try {
      const result = await fetch(
        `/api/appointments?action=${appointment ? 'update' : 'create'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Appointment-Action': '1',
          },
          body: JSON.stringify({
            id: appointment?.id || newId.current,
            version: appointment?.version,
            patient_id: selected.id,
            starts_at: startsAt,
            ends_at: endsAt,
            modality,
            admin_notes: notes,
          }),
        },
      );
      const data = (await result.json()) as { error?: string };
      if (!result.ok)
        throw new Error(data.error || 'Não foi possível salvar o horário.');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Digitar no campo do paciente desfaz a escolha anterior. */
  function typePatient(value: string) {
    setQuery(value);
    setPatient(null);
  }

  function pickOnlyMatch(e: React.KeyboardEvent<HTMLInputElement>) {
    // Enter com um único resultado escolhe esse paciente em vez de salvar.
    if (e.key !== 'Enter' || patient || matches.length !== 1) return;
    e.preventDefault();
    setPatient(matches[0]);
    setQuery(matches[0].social_name || matches[0].name);
    setMatches([]);
  }

  function pickPatient(item: Patient) {
    setPatient(item);
    setQuery(item.social_name || item.name);
    setMatches([]);
  }

  return {
    query,
    matches,
    patient,
    start,
    end,
    duration,
    durationInput,
    modality,
    notes,
    error,
    busy,
    typePatient,
    pickOnlyMatch,
    pickPatient,
    changeStart,
    setEnd,
    changeDuration,
    setDurationInput,
    setModality,
    setNotes,
    save,
  };
}
