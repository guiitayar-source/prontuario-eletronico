'use client';
import { ShieldCheck, Key } from 'lucide-react';
import type { SignatureProviderId } from '@/lib/signature/providers';
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

/** Seleção do provedor de certificado em nuvem ICP-Brasil (Bird ID ou VIDaaS). */
export function SignatureProviderDialog({
  busy,
  onSelectProvider,
}: {
  busy: boolean;
  onSelectProvider: (provider: SignatureProviderId) => void;
}) {
  return (
    <>
      <h2 id="dialog-title">Escolha seu certificado digital ICP-Brasil</h2>
      <p>
        Selecione qual aplicativo de certificado em nuvem você utiliza no celular
        para autorizar a sessão de assinatura (válida por 4 horas):
      </p>
      <div
        style={{
          display: 'grid',
          gap: '12px',
          marginTop: '14px',
          marginBottom: '8px',
        }}
      >
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onSelectProvider('birdid')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            height: 'auto',
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <ShieldCheck size={20} color="var(--accent)" />
            <span>
              <strong style={{ display: 'block', fontSize: '14px' }}>
                Bird ID (Soluti)
              </strong>
              <span
                style={{
                  display: 'block',
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  fontWeight: 400,
                }}
              >
                Certificado em nuvem Soluti / Vault ID (push ou OTP)
              </span>
            </span>
          </span>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--accent)',
            }}
          >
            Conectar →
          </span>
        </button>

        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onSelectProvider('vidaas')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            height: 'auto',
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Key size={20} color="var(--info)" />
            <span>
              <strong style={{ display: 'block', fontSize: '14px' }}>
                VIDaaS (Valid)
              </strong>
              <span
                style={{
                  display: 'block',
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  fontWeight: 400,
                }}
              >
                Certificado em nuvem Valid Certificadora (push ou QR/OTP)
              </span>
            </span>
          </span>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--info)',
            }}
          >
            Conectar →
          </span>
        </button>
      </div>
    </>
  );
}
