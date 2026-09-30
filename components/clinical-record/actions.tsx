'use client';
import { FileCheck, FileText, KeyRound, Loader2, Pill, ShieldCheck } from 'lucide-react';

/** Barra de ações da evolução: documentos, receita, rascunho, assinatura e adendo. */
export function EvolutionActions({
  isSigned,
  isFinalizedUnsigned,
  finalized,
  hasSignatureSession,
  busy,
  signing,
  ready,
  dirty,
  hasText,
  onNewDocument,
  onNewPrescription,
  onShowDetails,
  onAddendum,
  onSaveDraft,
  onSign,
  onConnect,
  onFinalizeUnsigned,
}: {
  isSigned: boolean;
  isFinalizedUnsigned: boolean;
  finalized: boolean;
  hasSignatureSession: boolean;
  busy: boolean;
  signing: boolean;
  ready: boolean;
  dirty: boolean;
  hasText: boolean;
  onNewDocument: () => void;
  onNewPrescription: () => void;
  onShowDetails: () => void;
  onAddendum: () => void;
  onSaveDraft: () => void;
  onSign: () => void;
  onConnect: () => void;
  onFinalizeUnsigned: () => void;
}) {
  return (
    <footer className="editor-actions">
      <button
        className="secondary"
        onClick={onNewDocument}
      >
        <FileText size={16} /> Novo documento
      </button>
      <button className="secondary" onClick={onNewPrescription}>
        <Pill size={16} /> Nova receita
      </button>
      {isSigned ? (
        <>
          <button
            type="button"
            className="secondary"
            onClick={onShowDetails}
          >
            <FileCheck size={16} /> Detalhes da assinatura
          </button>
          <button
            type="button"
            className="secondary"
            onClick={onAddendum}
          >
            Registrar adendo
          </button>
        </>
      ) : isFinalizedUnsigned ? (
        <div className="editor-action-buttons">
          <button
            type="button"
            className="secondary"
            onClick={onAddendum}
          >
            Registrar adendo
          </button>

          {hasSignatureSession ? (
            <button
              type="button"
              className="primary signature-btn"
              disabled={busy || signing}
              onClick={onSign}
            >
              {signing ? (
<>
  <Loader2 size={16} className="spin" /> Assinando ICP-Brasil…
</>
              ) : (
<>
  <ShieldCheck size={17} /> Assinar evolução (ICP-Brasil)
</>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="primary signature-connect-btn"
              disabled={busy || signing}
              onClick={onConnect}
            >
              <KeyRound size={17} /> Conectar Bird ID para assinar
            </button>
          )}
        </div>
      ) : finalized ? (
        <button
          type="button"
          className="secondary"
          onClick={onAddendum}
        >
          Registrar adendo
        </button>
      ) : (
        <div className="editor-action-buttons">
          <button
            type="button"
            className="secondary"
            disabled={!ready || busy || signing || !dirty}
            onClick={onSaveDraft}
          >
            Salvar rascunho
          </button>

          {hasSignatureSession ? (
            <button
              type="button"
              className="primary signature-btn"
              disabled={!ready || busy || signing || !hasText}
              onClick={onSign}
            >
              {signing ? (
<>
  <Loader2 size={16} className="spin" /> Assinando ICP-Brasil…
</>
              ) : (
<>
  <ShieldCheck size={17} /> Finalizar e assinar
</>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="primary signature-connect-btn"
              disabled={!ready || busy || signing || !hasText}
              onClick={onConnect}
            >
              <KeyRound size={17} /> Conectar Bird ID para assinar
            </button>
          )}

          <button
            type="button"
            className="ghost-button"
            style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}
            disabled={!ready || busy || signing || !hasText}
            onClick={onFinalizeUnsigned}
            title="Finalizar consulta sem aplicar assinatura digital ICP-Brasil"
          >
            Finalizar sem assinar
          </button>
        </div>
      )}
    </footer>
  );
}
