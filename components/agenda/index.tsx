'use client';
// Agenda do dia: lista de horários com chegada, falta e cancelamento, e o formulário de
// horário. A lógica está em use-agenda.ts; o formulário, em appointment-form.tsx.
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
} from 'lucide-react';
import { initials } from '@/lib/patient-fields';
import { NavigationRail } from '../navigation-rail';
import {
  SITUATION_LABEL,
  clock,
  dateInput,
  displayDate,
  situationOf,
} from './appointment';
import { AppointmentForm } from './appointment-form';
import { useAgenda } from './use-agenda';

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
  const {
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
  } = useAgenda();

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
          onSaved={reload}
        />
      )}
    </div>
  );
}
