'use client';
import { useState } from 'react';
import {
  documentKinds,
  documentTemplate,
  type ClinicalDocument,
} from '@/lib/document-fields';
import { Download, ShieldCheck, Key, Lock } from 'lucide-react';
import type { DocumentsController } from './use-documents';
import { DocumentAiBox } from './ai-box';
import { useFeature } from '../plan';
import {
  isSignatureProviderId,
  signatureProviderLabel,
} from '@/lib/signature/providers';
import { prescriptionCategories, prescriptionSigningBlock, type PrescriptionCategory } from '@/lib/sncr/policy';
import { RcePanel } from './rce-panel';
import { rceStateLabels } from '@/lib/sncr/rce';
export function DocumentEditor({
  docs,
  prescription = false,
}: {
  docs: DocumentsController;
  prescription?: boolean;
}) {
  const ai = useFeature('ia');
  const [choosingProvider, setChoosingProvider] = useState(false);
  // Validação expirada com a página aberta: revalida direto no mesmo provedor.
  const expiredProvider = isSignatureProviderId(docs.signatureExpired)
    ? docs.signatureExpired
    : undefined;
  const d = docs.draft;
  if (!d) return null;
  const isSigned = d.status === 'SIGNED' || d.status === 'SUPERSEDED';
  const isSigning = d.status === 'SIGNING';
  const isRecipe = d.kind === 'Receita';
  const rceLocked = !!d.rce_emission;
  const category = d.prescription_category || 'RCE';
  const signingBlock = isRecipe ? prescriptionSigningBlock(category) : null;
  const noun = prescription ? 'receita' : 'documento';

  function update(fields: Partial<ClinicalDocument>) {
    if (isSigned || isSigning || rceLocked) return;
    docs.setDraft({ ...d!, ...fields });
  }

  return (
    <>
      <h2 id="dialog-title">
        {rceLocked
          ? d.rce_emission!.state === 'SIGNED' ? 'RCE de teste assinada' : 'RCE de teste em preparação'
          : isSigned
          ? prescription
            ? 'Receita assinada digitalmente'
            : 'Documento assinado digitalmente'
          : d.version
            ? `Editar ${noun}`
            : prescription
              ? 'Nova receita'
              : 'Novo documento'}
      </h2>

      {isRecipe && (
        <p role="status" className="muted">
          {rceLocked
            ? rceStateLabels[d.rce_emission!.state]
            : isSigned
            ? 'Assinatura digital registrada. Este documento não possui confirmação de integração ao SNCR.'
            : isSigning
              ? 'Assinatura em andamento. Aguarde a conclusão antes de entregar a receita.'
              : d.status === 'SIGNATURE_FAILED'
                ? 'Falha na assinatura. O conteúdo foi preservado para revisão.'
              : 'Rascunho. Salvar no prontuário ou gerar um PDF para assinatura manual não emite uma receita eletrônica.'}
          {!rceLocked && ' A emissão integrada em produção ainda está indisponível.'}
        </p>
      )}
      {isRecipe && !isSigned && signingBlock && <p role="status">{signingBlock}</p>}

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
            A assinatura digital foi registrada e o conteúdo está bloqueado para edição. Para realizar alterações, duplique-o como um novo rascunho.
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
                  <strong>{signatureProviderLabel(docs.signatureSession.provider)} conectado:</strong> {docs.signatureSession.cpf} · {docs.signatureSession.certificateAlias || docs.signatureSession.certificateSubject.slice(0, 40)}
                </>
              ) : docs.signatureExpired ? (
                `A validação do ${signatureProviderLabel(docs.signatureExpired)} expirou. Revalide para assinar; o documento continua aqui.`
              ) : (
                'Certificado digital ICP-Brasil não conectado nesta sessão.'
              )}
            </span>
          </div>
          {docs.signatureSession ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className="text-button"
                onClick={() => void docs.disconnectSignature()}
                style={{ fontSize: '12px' }}
              >
                Desconectar
              </button>
            </div>
          ) : expiredProvider ? (
            <button
              type="button"
              className="primary"
              onClick={() => void docs.connectSignature(expiredProvider)}
              style={{ padding: '4px 10px', fontSize: '12px', height: '30px' }}
            >
              Revalidar {signatureProviderLabel(expiredProvider)}
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                type="button"
                className="secondary"
                onClick={() => void docs.connectSignature('birdid')}
                style={{ padding: '4px 10px', fontSize: '12px', height: '30px' }}
                title="Conectar certificado em nuvem Bird ID (Soluti)"
              >
                Bird ID
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void docs.connectSignature('vidaas')}
                style={{ padding: '4px 10px', fontSize: '12px', height: '30px' }}
                title="Conectar certificado em nuvem VIDaaS (Valid)"
              >
                VIDaaS
              </button>
            </div>
          )}
        </div>
      )}

      {docs.error && (
        <div className="capture-error" role="alert">
          {docs.error} Seu texto foi mantido para revisão.
        </div>
      )}
      <fieldset disabled={docs.busy || isSigned || isSigning || rceLocked} style={{ border: 0, padding: 0 }}>
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
        {isRecipe && (
          <label>
            Tipo de receituário
            <select value={category} onChange={(e) => update({ prescription_category: e.target.value as PrescriptionCategory })}>
              {Object.entries(prescriptionCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
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
          {d.kind === 'Receita' && category === 'RCE' && (
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
          {ai && !isSigned && (
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
      {isRecipe && category === 'RCE' && !isSigned && <RcePanel key={d.id} docs={docs} />}
      {rceLocked && <button type="button" className="secondary" onClick={() => docs.open(d, undefined, true)}>Duplicar como novo rascunho</button>}
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
              disabled={docs.busy || isSigning || rceLocked}
              onClick={() => void docs.save()}
            >
              Salvar rascunho
            </button>
            <button
              type="button"
              className="secondary"
              disabled={docs.busy || isSigning || rceLocked || !d.text.trim() || (isRecipe && category !== 'RCE')}
              onClick={() => void docs.pdf()}
            >
              {isRecipe ? 'PDF para impressão e assinatura manual' : 'Prévia / PDF'}
            </button>
            {!docs.signatureSession && choosingProvider ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Escolher certificado:
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={docs.busy}
                  onClick={() => {
                    setChoosingProvider(false);
                    void docs.connectSignature('birdid');
                  }}
                >
                  Bird ID (Soluti)
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={docs.busy}
                  onClick={() => {
                    setChoosingProvider(false);
                    void docs.connectSignature('vidaas');
                  }}
                >
                  VIDaaS (Valid)
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setChoosingProvider(false)}
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={docs.busy || isSigning || rceLocked || !!signingBlock || docs.signingDocId === d.id || !d.text.trim()}
                style={{
                  backgroundColor: docs.signatureSession ? 'var(--success)' : undefined,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                onClick={() => {
                  if (!docs.signatureSession) {
                    if (expiredProvider) void docs.connectSignature(expiredProvider);
                    else setChoosingProvider(true);
                    return;
                  }
                  const confirmed = window.confirm(
                    `Revise o conteúdo antes de assinar com seu certificado ${signatureProviderLabel(docs.signatureSession.provider)} ICP-Brasil. Após a assinatura, o documento ficará bloqueado para edição.${isRecipe ? ' Esta receita será assinada pelo fluxo de transição, sem integração com o SNCR.' : ''}`
                  );
                  if (confirmed) {
                    void docs.sign(d.id);
                  }
                }}
              >
                <Lock size={14} />
                {docs.signingDocId === d.id
                  ? `Assinando com ${signatureProviderLabel(docs.signatureSession?.provider)}…`
                  : docs.signatureSession
                    ? `Finalizar e assinar (${signatureProviderLabel(docs.signatureSession.provider)})`
                    : expiredProvider
                      ? `Revalidar ${signatureProviderLabel(expiredProvider)} para assinar`
                      : 'Conectar certificado para assinar'}
              </button>
            )}
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
                ? prescription
                  ? 'Rascunho salvo em “Receitas deste paciente” e na aba Documentos'
                  : 'Rascunho salvo na aba Documentos deste paciente'
                : 'Novo rascunho (ainda não salvo)'}
      </output>
      {docs.preview && (
        <>
          <p>
            {isSigned
              ? 'Arquivo original com assinatura digital ICP-Brasil.'
              : isRecipe ? 'PDF sem assinatura digital. Para a via física, imprima, revise os campos obrigatórios e assine manualmente.' : 'Prévia da versão salva. Use o visualizador para imprimir.'}
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
