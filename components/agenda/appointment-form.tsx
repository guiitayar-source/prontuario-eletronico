'use client';
// Formulário de novo horário e de edição de horário, aberto pela agenda.
// A lógica está em use-appointment-form.ts.
import { X } from 'lucide-react';
import { initials } from '@/lib/patient-fields';
import { MAX_DURATION, MIN_DURATION } from './appointment';
import {
  useAppointmentForm,
  type AppointmentFormProps,
} from './use-appointment-form';

export function AppointmentForm({
  day,
  appointment,
  onClose,
  onSaved,
}: AppointmentFormProps) {
  const {
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
  } = useAppointmentForm({ day, appointment, onClose, onSaved });

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
            onChange={(e) => typePatient(e.target.value)}
            onKeyDown={pickOnlyMatch}
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
                  onClick={() => pickPatient(item)}
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
