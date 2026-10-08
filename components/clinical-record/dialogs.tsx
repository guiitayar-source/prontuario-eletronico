'use client';
import type { useConsultationTimer } from './use-consultation-timer';

/** Confirmação de finalização sem assinatura digital. */
export function FinalizeDialog({
  timer,
  busy,
  onConfirm,
}: {
  timer: ReturnType<typeof useConsultationTimer>;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <>
      <h2 id="dialog-title">Finalizar esta consulta?</h2>
      <p>
        O texto ficará bloqueado para edição. Correções posteriores
        serão registradas como adendos.
      </p>
      <div className="info-box" style={{ marginBottom: 12 }}>
        Tempo de atendimento registrado:{' '}
        <strong>{timer.formattedDigits}</strong>
        {timer.humanDuration && timer.humanDuration !== '0 s'
          ? ` (${timer.humanDuration})`
          : ''}
      </div>
      <div className="info-box">
        Esta ação não aplica assinatura digital nem cria um prontuário
        válido para uso clínico.
      </div>
      <button className="primary" disabled={busy} onClick={onConfirm}>
        Confirmar finalização
      </button>
    </>
  );
}

/** Adendo a uma consulta finalizada: o texto original é preservado. */
export function AddendumDialog({
  value,
  busy,
  onChange,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <h2 id="dialog-title">Registrar adendo</h2>
      <p>
        O texto original será preservado. O adendo registrará autor e
        horário.
      </p>
      <textarea
        className="document-editor"
        aria-label="Novo adendo"
        value={value}
        maxLength={100000}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        className="primary"
        disabled={busy || !value.trim()}
        onClick={onSubmit}
      >
        Registrar adendo
      </button>
    </>
  );
}
