'use client';
import { apiFetch as fetch } from '@/lib/supabase/http';

import { useEffect, useMemo, useState, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
  X,
} from 'lucide-react';
import type { Patient } from '@/lib/patient-fields';
import { initials } from '@/lib/patient-fields';
import { NavigationRail } from './navigation-rail';

type Appointment = {
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

const SITUATION_LABEL: Record<Situation, string> = {
  scheduled: 'Agendado',
  waiting: 'Aguardando',
  in_progress: 'Em atendimento',
  completed: 'Finalizado',
  no_show: 'Faltou',
  unrecorded: 'Sem registro',
};

/** Situação mostrada: "aguardando" é um agendado com chegada; dia passado sem nada é "sem registro". */
const situationOf = (item: Appointment, past: boolean): Situation => {
  if (item.status !== 'scheduled') return item.status as Situation;
  if (item.arrived_at) return 'waiting';
  return past ? 'unrecorded' : 'scheduled';
};

const clock = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

const displayDate = (day: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00`));

const dateInput = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};

const localDateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

// Duração padrão da consulta, guardada no navegador de quem agenda.
const DURATION_KEY = 'psywrite-appointment-duration';
const MIN_DURATION = 10;
const MAX_DURATION = 480;
const validDuration = (minutes: number) =>
  Number.isInteger(minutes) &&
  minutes >= MIN_DURATION &&
  minutes <= MAX_DURATION;

const storedDuration = () => {
  try {
    const value = Number(localStorage.getItem(DURATION_KEY));
    return validDuration(value) ? value : 50;
  } catch {
    return 50; // localStorage indisponível
  }
};

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** Hora de término (HH:MM) para um início "AAAA-MM-DDTHH:MM" e uma duração. */
const endTime = (start: string, duration: number) => {
  const total = (minutesOf(start.slice(11, 16)) + duration) % 1440;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

function AppointmentForm({
  day,
  appointment,
  onClose,
  onSaved,
}: {
  day: string;
  appointment: Appointment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
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

  return (
    <div className="modal-backdrop">
      <form
        className="modal appointment-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appointment-title"
        onSubmit={save}
      >
        <button
          className="close"
          type="button"
          aria-label="Fechar"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="appointment-title">
          {appointment ? 'Editar horário' : 'Novo horário'}
        </h2>
        {error && (
          <div className="capture-error" role="alert">
            {error}
          </div>
        )}
        <label htmlFor="appointment-patient">
          <span>Paciente</span>
          <input
            id="appointment-patient"
            value={query}
            disabled={!!appointment || busy}
            placeholder="Busque pelo nome"
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setPatient(null);
            }}
            onKeyDown={(e) => {
              // Enter com um único resultado escolhe esse paciente em vez de salvar.
              if (e.key !== 'Enter' || patient || matches.length !== 1) return;
              e.preventDefault();
              setPatient(matches[0]);
              setQuery(matches[0].social_name || matches[0].name);
              setMatches([]);
            }}
          />
          {patient && (
            <small className="selected-patient">
              Paciente selecionado: {patient.social_name || patient.name}
            </small>
          )}
          {!appointment && matches.length > 0 && (
            <div className="patient-matches">
              {matches.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setPatient(item);
                    setQuery(item.social_name || item.name);
                    setMatches([]);
                  }}
                >
                  <span className="avatar patient">
                    {initials(item.social_name || item.name)}
                  </span>
                  {item.social_name || item.name}
                </button>
              ))}
            </div>
          )}
        </label>
        <div className="appointment-fields">
          <label htmlFor="appointment-start">
            <span>Início</span>
            <input
              id="appointment-start"
              type="datetime-local"
              value={start}
              disabled={busy}
              onChange={(e) => changeStart(e.target.value)}
            />
          </label>
          <label htmlFor="appointment-end">
            <span>Término</span>
            <input
              id="appointment-end"
              type="time"
              value={end}
              disabled={busy}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label htmlFor="appointment-duration">
            <span>Duração padrão</span>
            <span className="duration-input">
              <input
                id="appointment-duration"
                type="number"
                inputMode="numeric"
                min={MIN_DURATION}
                max={MAX_DURATION}
                value={durationInput}
                disabled={busy}
                onChange={(e) => changeDuration(e.target.value)}
                onBlur={() => setDurationInput(String(duration))}
              />
              <small>min</small>
            </span>
          </label>
        </div>
        <label htmlFor="appointment-modality">
          <span>Modalidade</span>
          <select
            id="appointment-modality"
            value={modality}
            disabled={busy}
            onChange={(e) => setModality(e.target.value)}
          >
            <option value="presencial">Presencial</option>
            <option value="teleconsulta">Teleconsulta</option>
          </select>
        </label>
        <label htmlFor="appointment-notes">
          <span>Observação administrativa</span>
          <textarea
            id="appointment-notes"
            maxLength={1000}
            value={notes}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ex.: primeira consulta, retorno, convênio…"
          />
        </label>
        <footer className="form-actions">
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar horário'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default function Agenda({
  onPatients,
  onOpenPatient,
  onTeam,
  onSettings,
}: {
  onPatients: () => void;
  onOpenPatient: (id: string, appointmentId?: string) => void;
  onTeam?: () => void;
  onSettings?: () => void;
}) {
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

  return (
    <div className="app-shell">
      <NavigationRail
        active="agenda"
        onPatients={onPatients}
        onConsultation={onPatients}
        onTeam={onTeam}
        onSettings={onSettings}
      />
      <div className="main-shell">
        <main>
          <section className="agenda-heading">
            <div>
              <div className="eyebrow">AGENDA</div>
              <h1>{displayDate(day)}</h1>
              {!loading && appointments.length > 0 && (
                <p className="agenda-summary">{summary}</p>
              )}
            </div>
            <div className="agenda-actions">
              <button
                className="secondary"
                aria-label="Dia anterior"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="secondary"
                onClick={() => setDay(dateInput(new Date()))}
              >
                Hoje
              </button>
              <button
                className="secondary"
                aria-label="Próximo dia"
                onClick={() => move(1)}
              >
                <ChevronRight size={18} />
              </button>
              <input
                type="date"
                aria-label="Escolher data"
                value={day}
                onChange={(e) => {
                  if (e.target.value) setDay(e.target.value);
                }}
              />
              <button className="primary" onClick={() => setEditing('new')}>
                <Plus size={18} /> Novo horário
              </button>
            </div>
          </section>
          {error && (
            <div className="capture-error" role="alert">
              {error}
            </div>
          )}
          <section className="agenda-list">
            {loading ? (
              <p className="registry-empty" role="status">
                Carregando agenda…
              </p>
            ) : appointments.length ? (
              appointments.map((item) => {
                const situation = situationOf(item, past);
                const open = () => onOpenPatient(item.patient_id, item.id);
                const pending = item.status === 'scheduled';
                return (
                  <article
                    className={`appointment-card ${situation}`}
                    key={item.id}
                  >
                    <time>
                      <strong>{clock(item.starts_at)}</strong>
                      <span>{clock(item.ends_at)}</span>
                    </time>
                    <span className="avatar patient">
                      {initials(item.patient_social_name || item.patient_name)}
                    </span>
                    <div className="appointment-card-main">
                      <strong>
                        {item.patient_social_name || item.patient_name}
                      </strong>
                      <span>
                        {item.modality === 'teleconsulta'
                          ? 'Teleconsulta'
                          : 'Presencial'}
                        {item.arrived_at && situation === 'waiting'
                          ? ` · chegou às ${clock(item.arrived_at)}`
                          : ''}
                        {item.admin_notes ? ` · ${item.admin_notes}` : ''}
                      </span>
                    </div>
                    <span className={`appointment-status ${situation}`}>
                      {SITUATION_LABEL[situation]}
                    </span>
                    {pending && !item.arrived_at && !past && (
                      <button
                        className="secondary"
                        onClick={() => act(item, 'arrive')}
                      >
                        Registrar chegada
                      </button>
                    )}
                    {pending && (
                      <button className="secondary" onClick={open}>
                        Iniciar consulta
                      </button>
                    )}
                    {item.status === 'in_progress' && (
                      <button className="secondary" onClick={open}>
                        Continuar consulta
                      </button>
                    )}
                    {item.status === 'completed' && (
                      <button className="secondary" onClick={open}>
                        Abrir consulta
                      </button>
                    )}
                    {pending && (
                      <button
                        className="text-button"
                        onClick={() => setEditing(item)}
                      >
                        Editar
                      </button>
                    )}
                    {pending &&
                      !item.arrived_at &&
                      item.starts_at <= Date.now() && (
                        <button
                          className="text-button"
                          onClick={() => act(item, 'no_show')}
                        >
                          Faltou
                        </button>
                      )}
                    {(item.status === 'no_show' ||
                      (pending && item.arrived_at)) && (
                        <button
                          className="text-button"
                          onClick={() => act(item, 'reset')}
                        >
                          {item.status === 'no_show'
                            ? 'Desfazer falta'
                            : 'Desfazer chegada'}
                        </button>
                      )}
                    {pending && (
                      <button
                        className="text-button danger-text"
                        onClick={() => act(item, 'cancel')}
                      >
                        Cancelar
                      </button>
                    )}
                  </article>
                );
              })
            ) : (
              <div className="agenda-empty">
                <Clock3 size={30} />
                <h2>Sem horários neste dia</h2>
                <p>Crie um horário e vincule-o a um paciente cadastrado.</p>
                <button className="secondary" onClick={() => setEditing('new')}>
                  <Plus size={17} /> Novo horário
                </button>
              </div>
            )}
          </section>
        </main>
      </div>
      {editing !== null && (
        <AppointmentForm
          day={day}
          appointment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setRevision((value) => value + 1)}
        />
      )}
    </div>
  );
}
