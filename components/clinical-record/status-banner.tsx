'use client';
import { KeyRound, Loader2, LockKeyhole, ShieldCheck, FileCheck } from 'lucide-react';
import { date, type RecordEntry } from './types';

/** Aviso abaixo da evolução: assinada, finalizada sem assinatura ou finalizada. */
export function EvolutionStatusBanner({
  current,
  isSigned,
  isFinalizedUnsigned,
  finalized,
  hasSignatureSession,
  busy,
  signing,
  onSign,
  onConnect,
  onShowDetails,
}: {
  current: RecordEntry | null;
  isSigned: boolean;
  isFinalizedUnsigned: boolean;
  finalized: boolean;
  hasSignatureSession: boolean;
  busy: boolean;
  signing: boolean;
  onSign: () => void;
  onConnect: () => void;
  onShowDetails: () => void;
}) {
  return (
    <>
      {isSigned && current ? (
        <div className="signed-evolution-banner">
          <div className="signed-badge-header">
            <ShieldCheck size={20} className="signed-badge-icon" />
            <div>
              <strong>Evolução assinada digitalmente (ICP-Brasil)</strong>
              <p>
                Assinada em {date(current.signed_at || current.created_at)}
                {current.current_signature?.certificate_subject
                  ? ` por ${current.current_signature.certificate_subject.match(/CN=([^,\n/]+)/i)?.[1] || current.current_signature.certificate_subject}`
                  : ''}
                . Registro eletrônico nativo imutável.
              </p>
            </div>
            <button
              type="button"
              className="secondary compact-btn"
              onClick={onShowDetails}
            >
              <FileCheck size={15} /> Ver detalhes da assinatura
            </button>
          </div>
        </div>
      ) : isFinalizedUnsigned ? (
        <div className="unsigned-finalized-banner">
          <div className="unsigned-finalized-header">
            <div className="unsigned-badge-icon">
              <KeyRound size={20} />
            </div>
            <div className="unsigned-badge-text">
              <strong>Consulta finalizada sem assinatura digital</strong>
              <p>
                Finalizada em {current?.finalized_at && date(current.finalized_at)}.
                Você pode assinar este registro eletrônico agora com seu certificado digital ICP-Brasil.
              </p>
            </div>
            {hasSignatureSession ? (
              <button
                type="button"
                className="primary signature-btn compact-btn"
                disabled={busy || signing}
                onClick={onSign}
              >
                {signing ? (
                  <>
                    <Loader2 size={14} className="spin" /> Assinando…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={15} /> Assinar agora (ICP-Brasil)
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                className="primary signature-connect-btn compact-btn"
                disabled={busy || signing}
                onClick={onConnect}
              >
                <KeyRound size={15} /> Conectar Bird ID para assinar
              </button>
            )}
          </div>
        </div>
      ) : finalized ? (
        <div className="finalized-info">
          <LockKeyhole size={15} /> Finalizada em{' '}
          {current?.finalized_at && date(current.finalized_at)}.
          Correções por adendos. Sem assinatura digital.
        </div>
      ) : null}
    </>
  );
}
