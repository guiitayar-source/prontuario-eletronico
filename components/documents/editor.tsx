'use client';
import {
  documentKinds,
  documentTemplate,
  type ClinicalDocument,
} from '@/lib/document-fields';
import { Download, ShieldCheck, Key, Lock } from 'lucide-react';
import type { DocumentsController } from './use-documents';
import { DocumentAiBox } from './ai-box';
export function DocumentEditor({
  docs,
  prescription = false,
}: {
  docs: DocumentsController;
  prescription?: boolean;
}) {
  const d = docs.draft;
  if (!d) return null;
  const isSigned = d.status === 'SIGNED';
  const noun = prescription ? 'receita' : 'documento';

  function update(fields: Partial<ClinicalDocument>) {
    if (isSigned) return;
    docs.setDraft({ ...d!, ...fields });
  }

  return (
    <>
      <h2 id="dialog-title">
        {isSigned
          ? prescription
            ? 'Receita assinada digitalmente'
            : 'Documento assinado digitalmente'
          : d.version
            ? `Editar ${noun}`
            : prescription
              ? 'Nova receita'
              : 'Novo documento'}
      </h2>

      {docs.signatureNotice && (
        <output
          style={{
            display: 'block',
            padding: '10px 14px',
            marginBottom: '12px',
            borderRadius: '6px',
            fontSize: '13px',
            backgroundColor:
              docs.signatureNotice.type === 'success' ? 'var(--accent-soft)' : 'var(--danger-soft)',
            color:
              docs.signatureNotice.type === 'success' ? 'var(--success)' : 'var(--danger)',
            border: `1px solid ${
              docs.signatureNotice.type === 'success' ? 'var(--accent-border)' : 'var(--danger-border)'
            }`,
          }}
        >
          {docs.signatureNotice.message}
        </output>
      )}

      {isSigned ? (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: 'var(--accent-soft)',
            border: '1px solid var(--accent-border)',
            borderRadius: '6px',
            marginBottom: '16px',
            color: 'var(--success)',
            fontSize: '13px',
          }}
        >
          <strong>✓ Assinado Digitalmente • ICP-Brasil (PAdES)</strong>
          <p style={{ margin: '4px 0 0 0' }}>
            Este documento possui assinatura digital válida e seu conteúdo é imutável. Para realizar alterações, duplique-o como um novo rascunho.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            backgroundColor: docs.signatureSession ? 'var(--info-soft)' : 'var(--surface)',
            border: `1px solid ${docs.signatureSession ? 'var(--info-border)' : 'var(--border)'}`,
            borderRadius: '6px',
            marginBottom: '16px',
            fontSize: '13px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {docs.signatureSession ? (
              <ShieldCheck size={18} color="var(--info)" />
            ) : (
              <Key size={18} color="var(--text-muted)" />
            )}
            <span>
              {docs.signatureSession ? (
                <>
                  <strong>Bird ID Conectado:</strong> {docs.signatureSession.cpf} · {docs.signatureSession.certificateAlias || docs.signatureSession.certificateSubject.slice(0, 40)}
                </>
              ) : (
                'Certificado digital Bird ID não conectado nesta sessão.'
              )}
            </span>
          </div>
          {docs.signatureSession ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className="text-button"
                onClick={() => void docs.disconnectBirdId()}
                style={{ fontSize: '12px' }}
              >
                Desconectar
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => void docs.connectBirdId()}
              style={{ padding: '4px 12px', fontSize: '12px', height: '30px' }}
            >
              Conectar Bird ID
            </button>
          )}
        </div>
      )}

      {docs.error && (
        <div className="capture-error" role="alert">
          {docs.error} Seu texto foi mantido para revisão.
        </div>
      )}
      <fieldset disabled={docs.busy || isSigned} style={{ border: 0, padding: 0 }}>
        {!prescription && (
          <>
            <label htmlFor="doctype">Tipo de documento</label>
            <select
              id="doctype"
              value={d.kind}
              disabled={isSigned}
              onChange={(e) => {
                const nextKind = e.target.value;
                if (!d.text.trim()) {
                  update({ kind: nextKind, text: documentTemplate(nextKind) });
                } else {
                  update({ kind: nextKind });
                }
              }}
            >
              {documentKinds.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </>
        )}
        <label>
          Paciente
          <input value={d.patient_name} readOnly />
        </label>
        <label>
          {d.kind === 'Receita' ? 'Data (opcional)' : 'Data'}
          <input
            type="date"
            value={d.document_date || ''}
            readOnly={isSigned}
            onChange={(e) => update({ document_date: e.target.value })}
          />
        </label>
        <label>
          Nome profissional
          <input
            maxLength={180}
            value={d.physician_name}
            readOnly={isSigned}
            onChange={(e) => update({ physician_name: e.target.value })}
          />
        </label>
        <label>
          CRM/UF e RQE
          <input
            maxLength={120}
            value={d.physician_registration}
            readOnly={isSigned}
            onChange={(e) => update({ physician_registration: e.target.value })}
          />
        </label>
        {d.consultation_id && (
          <label>
            <input
              type="checkbox"
              checked
              disabled={isSigned}
              onChange={() => update({ consultation_id: null })}
            />{' '}
            Vinculado à consulta selecionada
          </label>
        )}
        <div className="document-tools">
          {!isSigned && (
            <button
              className="secondary"
              onClick={() => {
                if (!d.text || window.confirm('Substituir o texto pelo modelo?'))
                  update({ text: documentTemplate(d.kind) });
              }}
            >
              Preparar modelo
            </button>
          )}
          {d.kind === 'Receita' && (
            <a
              href="/templates/Receituario-padrao.docx"
              download="Receituario-padrao.docx"
              className="secondary"
              style={{
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0 12px',
                height: '36px',
                fontSize: '13px',
              }}
              title="Baixar modelo original do receituário em Word (.docx)"
            >
              <Download size={14} />
              Baixar modelo Word (.docx)
            </a>
          )}
          {!isSigned && (
            <DocumentAiBox
              key={`${d.id}:${d.kind}`}
              document={d}
              onApply={(text) => update({ text })}
            />
          )}
        </div>
        <textarea
          className="document-editor"
          aria-label="Texto do documento"
          maxLength={100000}
          value={d.text}
          readOnly={isSigned}
          onChange={(e) => update({ text: e.target.value })}
        />
      </fieldset>
      <div className="editor-actions">
        {isSigned ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={docs.busy}
              onClick={() => void docs.pdf()}
            >
              Visualizar / Baixar PDF Assinado
            </button>
            <button
              type="button"
              className="secondary"
              disabled={docs.busy}
              onClick={() => docs.open(d, undefined, true)}
            >
              Duplicar como novo rascunho
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              disabled={docs.busy}
              onClick={() => void docs.save()}
            >
              Salvar rascunho
            </button>
            <button
              type="button"
              className="secondary"
              disabled={docs.busy || !d.text.trim()}
              onClick={() => void docs.pdf()}
            >
              Prévia / PDF
            </button>
            <button
              type="button"
              className="primary"
              disabled={docs.busy || docs.signingDocId === d.id || !d.text.trim()}
              style={{
                backgroundColor: docs.signatureSession ? 'var(--success)' : undefined,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
              onClick={() => {
                if (!docs.signatureSession) {
                  void docs.connectBirdId();
                  return;
                }
                const confirmed = window.confirm(
                  'Deseja assinar digitalmente este documento com seu certificado Bird ID ICP-Brasil? Após a assinatura digital, o documento se tornará imutável e terá plena validade jurídica.'
                );
                if (confirmed) {
                  void docs.sign(d.id);
                }
              }}
            >
              <Lock size={14} />
              {docs.signingDocId === d.id
                ? 'Assinando com Bird ID…'
                : docs.signatureSession
                  ? 'Finalizar e assinar (Bird ID)'
                  : 'Conectar Bird ID para assinar'}
            </button>
          </>
        )}
      </div>
      <output
        style={{
          display: 'block',
          fontSize: '12px',
          color: 'var(--text-muted)',
          margin: '6px 0',
        }}
      >
        {docs.busy
          ? 'Processando…'
          : isSigned
            ? 'Documento assinado digitalmente (imutável)'
            : docs.dirty
              ? 'Alterações não salvas'
              : d.version
                ? 'Salvo'
                : 'Novo rascunho'}
      </output>
      {docs.preview && (
        <>
          <p>
            {isSigned
              ? 'PDF oficial com assinatura digital ICP-Brasil.'
              : 'Prévia da versão salva. Use o visualizador para imprimir.'}
          </p>
          <iframe
            title="Prévia do documento em PDF"
            src={docs.preview}
            style={{ width: '100%', height: 440, border: '1px solid var(--border)' }}
          />
          <a
            className="secondary"
            href={docs.preview}
            download={isSigned ? 'documento_assinado.pdf' : 'documento.pdf'}
          >
            Baixar PDF {isSigned ? 'Assinado' : ''}
          </a>
        </>
      )}
    </>
  );
}
