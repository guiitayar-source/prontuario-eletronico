'use client';
import { apiFetch as fetch } from '@/lib/supabase/http';

import { useEffect, useMemo, useState, useRef } from 'react';
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
  ShieldCheck,
  Stethoscope,
  Users,
  X,
} from 'lucide-react';
import type { Patient } from '@/lib/patient-fields';
import { initials } from '@/lib/patient-fields';

type Appointment = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_social_name: string | null;
  starts_at: number;
  ends_at: number;
  modality: 'presencial' | 'teleconsulta';
  status: 'scheduled' | 'cancelled';
  admin_notes: string | null;
  version: number;
};

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

function Navigation({
  onPatients,
  onConsultation,
  onTeam,
}: {
  onPatients: () => void;
  onConsultation: () => void;
  onTeam?: () => void;
}) {
  return (
    <aside className="rail">
      <div className="brand">
        <Activity size={23} />
      </div>
      <nav aria-label="Navegação principal">
        <button className="nav-item active">
          <CalendarDays size={21} />
          <span>Agenda</span>
        </button>
        <button className="nav-item" onClick={onPatients}>
          <Users size={21} />
          <span>Pacientes</span>
        </button>
        <button className="nav-item" onClick={onConsultation}>
          <Stethoscope size={21} />
          <span>Consulta</span>
        </button>
        {onTeam && (
          <button className="nav-item" onClick={onTeam}>
            <ShieldCheck size={21} />
            <span>Equipe</span>
          </button>
        )}
      </nav>
      <div className="rail-bottom">
        <span className="avatar doctor">G</span>
        <span>Médico</span>
      </div>
    </aside>
  );
}

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
  const [end, setEnd] = useState(
    appointment ? localDateTime(appointment.ends_at) : `${day}T09:50`,
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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const selected =
      patient || (appointment ? { id: appointment.patient_id } : null);
    if (!selected) return setError('Selecione um paciente.');
    const startsAt = new Date(start).getTime();
    const endsAt = new Date(end).getTime();
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt))
      return setError('Informe data e horários válidos.');
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
            onChange={(e) => {
              setQuery(e.target.value);
              setPatient(null);
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
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label htmlFor="appointment-end">
            <span>Término</span>
            <input
              id="appointment-end"
              type="datetime-local"
              value={end}
              disabled={busy}
              onChange={(e) => setEnd(e.target.value)}
            />
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
}: {
  onPatients: () => void;
  onOpenPatient: (id: string, appointmentId?: string) => void;
  onTeam?: () => void;
}) {
  const [day, setDay] = useState(dateInput(new Date()));
  const [items, setItems] = useState<Appointment[]>([]);
  const [editing, setEditing] = useState<Appointment | null | 'new'>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const appointments = useMemo(
    () => items.filter((item) => item.status === 'scheduled'),
    [items],
  );

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

  async function cancel(item: Appointment) {
    if (
      !window.confirm(
        `Cancelar o horário de ${item.patient_social_name || item.patient_name}?`,
      )
    )
      return;
    try {
      const result = await fetch('/api/appointments?action=cancel', {
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
      setError((e as Error).message || 'Não foi possível cancelar o horário.');
    }
  }
  const move = (amount: number) => {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() + amount);
    setDay(dateInput(date));
  };

  return (
    <div className="app-shell">
      <Navigation
        onPatients={onPatients}
        onConsultation={onPatients}
        onTeam={onTeam}
      />
      <div className="main-shell">
        <header className="topbar">
          <div className="wordmark">
            meu prontuário<span>CONSULTÓRIO</span>
          </div>
          <span className="demo-label">Protótipo · dados fictícios</span>
        </header>
        <main>
          <section className="agenda-heading">
            <div>
              <div className="eyebrow">AGENDA</div>
              <h1>{displayDate(day)}</h1>
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
              appointments.map((item) => (
                <article className="appointment-card" key={item.id}>
                  <time>
                    <strong>
                      {new Date(item.starts_at).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </strong>
                    <span>
                      {new Date(item.ends_at).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
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
                      {item.admin_notes ? ` · ${item.admin_notes}` : ''}
                    </span>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => onOpenPatient(item.patient_id, item.id)}
                  >
                    Iniciar consulta
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setEditing(item)}
                  >
                    Editar
                  </button>
                  <button
                    className="text-button danger-text"
                    onClick={() => cancel(item)}
                  >
                    Cancelar
                  </button>
                </article>
              ))
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
