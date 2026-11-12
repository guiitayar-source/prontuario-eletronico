// Lógica da agenda: o dia aberto, os horários dele e as ações de chegada, falta e
// cancelamento. A tela está em index.tsx.
import { apiFetch as fetch } from '@/lib/supabase/http';
import { useEffect, useMemo, useState } from 'react';
import { dateInput, type Appointment } from './appointment';

/** Estado e ações da agenda do dia. */
export function useAgenda() {
  const [day, setDay] = useState(dateInput(new Date()));
  const [items, setItems] = useState<Appointment[]>([]);
  const [editing, setEditing] = useState<Appointment | null | 'new'>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // Cancelados saem da lista; atendidos e faltas continuam, para consulta posterior.
  const appointments = useMemo(
    () => items.filter((item) => item.status !== 'cancelled'),
    [items],
  );
  const today = dateInput(new Date());
  const past = day < today;
  const summary = useMemo(() => {
    const count = (status: Appointment['status']) =>
      appointments.filter((item) => item.status === status).length;
    const parts = [
      `${appointments.length} ${appointments.length === 1 ? 'horário' : 'horários'}`,
    ];
    const completed = count('completed');
    const missed = count('no_show');
    if (completed)
      parts.push(`${completed} ${completed === 1 ? 'atendido' : 'atendidos'}`);
    if (missed) parts.push(`${missed} ${missed === 1 ? 'falta' : 'faltas'}`);
    return parts.join(' · ');
  }, [appointments]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/appointments?day=${day}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (result) => {
        const data = (await result.json()) as {
          appointments?: Appointment[];
          error?: string;
        };
        if (!result.ok) throw new Error(data.error);
        setItems(data.appointments || []);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            (e as Error).message || 'Não foi possível carregar a agenda.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [day, revision]);

  async function act(
    item: Appointment,
    action: 'cancel' | 'arrive' | 'no_show' | 'reset',
  ) {
    const name = item.patient_social_name || item.patient_name;
    if (
      action === 'cancel' &&
      !window.confirm(`Cancelar o horário de ${name}?`)
    )
      return;
    if (
      action === 'no_show' &&
      !window.confirm(`Registrar que ${name} faltou?`)
    )
      return;
    try {
      const result = await fetch(`/api/appointments?action=${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Appointment-Action': '1',
        },
        body: JSON.stringify({ id: item.id, version: item.version }),
      });
      const data = (await result.json()) as { error?: string };
      if (!result.ok) throw new Error(data.error);
      setRevision((value) => value + 1);
    } catch (e) {
      setError((e as Error).message || 'Não foi possível atualizar o horário.');
    }
  }
  const move = (amount: number) => {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() + amount);
    setDay(dateInput(date));
  };

  /** Recarrega a lista do dia (depois de salvar um horário). */
  function reload() {
    setRevision((value) => value + 1);
  }

  return {
    day,
    setDay,
    appointments,
    editing,
    setEditing,
    error,
    loading,
    past,
    summary,
    act,
    move,
    reload,
  };
}
