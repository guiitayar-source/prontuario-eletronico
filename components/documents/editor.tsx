'use client';
import { useState } from 'react';
import {
  buildPrescriptionText,
  documentKinds,
  documentTemplate,
  parsePrescriptionText,
  prescriptionModalities,
  type ClinicalDocument,
  type PrescriptionModality,
} from '@/lib/document-fields';
import { Download, ShieldCheck, Key, Lock, Layers, Trash2 } from 'lucide-react';
import type { DocumentsController } from './use-documents';
import { DocumentAiBox } from './ai-box';
import { useFeature } from '../plan';
import {
  isSignatureProviderId,
  signatureProviderLabel,
} from '@/lib/signature/providers';
export function DocumentEditor({
  docs,
  prescription = false,
}: {
  docs: DocumentsController;
  prescription?: boolean;
}) {
  const ai = useFeature('ia');
  const [choosingProvider, setChoosingProvider] = useState(false);
  const [showSncrBatches, setShowSncrBatches] = useState(false);
  const [batchLabel, setBatchLabel] = useState('');
  const [batchInicio, setBatchInicio] = useState('');
  const [batchFim, setBatchFim] = useState('');
  const [batchRawList, setBatchRawList] = useState('');
  // Validação expirada com a página aberta: revalida direto no mesmo provedor.
  const expiredProvider = isSignatureProviderId(docs.signatureExpired)
    ? docs.signatureExpired
    : undefined;
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
        {d.kind === 'Receita' && (
          <p className="document-template-note" style={{ marginTop: '-4px', marginBottom: '10px' }}>
            {docs.patientCpf
              ? `CPF do paciente incluído no PDF (${docs.patientCpf}).`
              : 'Sem CPF no cadastro do paciente (exigido pela RDC Anvisa nº 1.000/2025 para receitas controladas).'}{' '}
            {docs.patientHasAddress
              ? 'Endereço cadastrado.'
              : 'Sem endereço completo no cadastro.'}
          </p>
        )}
        {d.kind === 'Receita' && (() => {
          const rxMeta = parsePrescriptionText(d.text);
          const modalityCfg =
            prescriptionModalities.find((m) => m.id === rxMeta.modality) ||
            prescriptionModalities[0];
          return (
            <>
              <label htmlFor="prescription-modality">
                Modalidade da receita (Anvisa)
                <select
                  id="prescription-modality"
                  value={rxMeta.modality}
                  disabled={isSigned}
                  onChange={(e) => {
                    const nextModality = e.target.value as PrescriptionModality;
                    update({
                      text: buildPrescriptionText({
                        modality: nextModality,
                        sncrNumber:
                          nextModality === 'simples' ? '' : rxMeta.sncrNumber,
                        viaAdmin: rxMeta.viaAdmin,
                        bodyText: rxMeta.bodyText,
                      }),
                    });
                  }}
                >
                  {prescriptionModalities.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {rxMeta.modality !== 'simples' && (() => {
                const modalityBatches = (docs.sncrBatches || []).filter(
                  (b) => b.modality === rxMeta.modality,
                );
                const totalRemaining = modalityBatches.reduce(
                  (acc, b) => acc + b.remaining,
                  0,
                );
                const totalNumbers = modalityBatches.reduce(
                  (acc, b) => acc + b.total,
                  0,
                );
                const firstAvailable =
                  modalityBatches.find((b) => b.nextNumber)?.nextNumber || null;

                return (
                  <div style={{ marginBottom: '12px' }}>
                    <label htmlFor="prescription-sncr">
                      {modalityCfg.requiresSncrWhenSigned
                        ? 'Número SNCR — Anvisa (obrigatório para assinar digitalmente)'
                        : 'Número SNCR — Anvisa (RDC 1.000/2025 — puxado do seu lote ou informado)'}
                      <div
                        style={{
                          display: 'flex',
                          gap: '8px',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <input
                          id="prescription-sncr"
                          maxLength={60}
                          placeholder={
                            firstAvailable
                              ? `Próximo do lote: ${firstAvailable}`
                              : 'Ex.: 2602.6-53.0000001'
                          }
                          value={rxMeta.sncrNumber}
                          readOnly={isSigned}
                          style={{ flex: 1, minWidth: '180px' }}
                          onChange={(e) =>
                            update({
                              text: buildPrescriptionText({
                                modality: rxMeta.modality,
                                sncrNumber: e.target.value,
                                viaAdmin: rxMeta.viaAdmin,
                                bodyText: rxMeta.bodyText,
                              }),
                            })
                          }
                        />
                        {!isSigned && (
                          <>
                            <button
                              type="button"
                              className="secondary"
                              disabled={docs.busy}
                              onClick={() => void docs.requestSncrNumber()}
                              title="Puxar o próximo número livre do seu lote SNCR (ou solicitar na API da Anvisa)"
                              style={{ whiteSpace: 'nowrap' }}
                            >
                              {totalRemaining > 0
                                ? `Usar nº do lote (${totalRemaining})`
                                : 'Gerar nº no SNCR'}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={docs.busy}
                              onClick={() => setShowSncrBatches((v) => !v)}
                              title="Cadastrar ou gerenciar lotes de numeração SNCR obtidos no site da Anvisa (sem precisar de e-CNPJ)"
                              style={{
                                whiteSpace: 'nowrap',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                              }}
                            >
                              <Layers size={14} />
                              Lotes SNCR
                            </button>
                          </>
                        )}
                      </div>
                    </label>
                    <p
                      className="document-template-note"
                      style={{ marginTop: '4px', marginBottom: '4px' }}
                    >
                      {modalityBatches.length > 0 ? (
                        <>
                          <strong>Estoque ({modalityCfg.label}):</strong>{' '}
                          {totalRemaining} disponíveis de {totalNumbers}
                          {firstAvailable ? ` · Próximo: ${firstAvailable}` : ' · Lote esgotado'}
                          {totalRemaining > 0 && !rxMeta.sncrNumber
                            ? ' (se deixar em branco, o próximo número será preenchido automaticamente ao assinar).'
                            : ''}
                        </>
                      ) : (
                        <>
                          Nenhum lote cadastrado para {modalityCfg.label}. Clique em{' '}
                          <strong>Lotes SNCR</strong> para salvar sua faixa de números obtida no
                          site da Anvisa (sem precisar de e-CNPJ).
                        </>
                      )}
                    </p>
                    {showSncrBatches && !isSigned && (
                      <div
                        style={{
                          padding: '12px 14px',
                          backgroundColor: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          marginTop: '8px',
                          fontSize: '13px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: '8px',
                          }}
                        >
                          <strong>
                            Estoque de Lotes SNCR — {modalityCfg.label}
                          </strong>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setShowSncrBatches(false)}
                          >
                            Fechar
                          </button>
                        </div>
                        <p
                          className="document-template-note"
                          style={{ marginTop: 0, marginBottom: '10px' }}
                        >
                          Pegue um lote de números no portal{' '}
                          <a
                            href="https://sncr.anvisa.gov.br"
                            target="_blank"
                            rel="noreferrer"
                          >
                            sncr.anvisa.gov.br
                          </a>{' '}
                          e salve a faixa abaixo. O PsyWrite puxará o próximo número livre
                          automaticamente a cada receita, sem precisar de e-CNPJ.
                        </p>

                        {modalityBatches.length > 0 && (
                          <ul
                            className="prescription-list"
                            style={{ marginBottom: '12px' }}
                          >
                            {modalityBatches.map((b) => (
                              <li
                                key={b.id}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: '8px',
                                }}
                              >
                                <div>
                                  <strong>{b.label}</strong>
                                  <span
                                    className="prescription-summary"
                                    style={{ display: 'block' }}
                                  >
                                    Restantes: <strong>{b.remaining}</strong> de{' '}
                                    {b.total} (usados: {b.used})
                                    {b.nextNumber
                                      ? ` · Próximo: ${b.nextNumber}`
                                      : ' · Esgotado'}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="text-button danger"
                                  disabled={docs.busy}
                                  title={`Remover lote ${b.label}`}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Remover o lote SNCR "${b.label}"?`,
                                      )
                                    ) {
                                      void docs.deleteSncrBatch(b.id);
                                    }
                                  }}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns:
                              'repeat(auto-fit, minmax(180px, 1fr))',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <label style={{ margin: 0 }}>
                            Nº inicial da faixa
                            <input
                              placeholder="Ex.: 2602.6-53.0000001"
                              value={batchInicio}
                              onChange={(e) => setBatchInicio(e.target.value)}
                            />
                          </label>
                          <label style={{ margin: 0 }}>
                            Nº final da faixa
                            <input
                              placeholder="Ex.: 2602.6-53.0000100"
                              value={batchFim}
                              onChange={(e) => setBatchFim(e.target.value)}
                            />
                          </label>
                          <label style={{ margin: 0 }}>
                            Identificação (opcional)
                            <input
                              placeholder="Ex.: Lote C1 Out/2026"
                              maxLength={80}
                              value={batchLabel}
                              onChange={(e) => setBatchLabel(e.target.value)}
                            />
                          </label>
                        </div>

                        <label style={{ marginBottom: '8px' }}>
                          Ou cole uma lista de números (separados por vírgula ou
                          linha)
                          <textarea
                            rows={2}
                            placeholder="Opcional se você já preencheu o Nº inicial e Nº final acima"
                            value={batchRawList}
                            onChange={(e) => setBatchRawList(e.target.value)}
                            style={{ minHeight: '52px' }}
                          />
                        </label>

                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              docs.busy ||
                              (!batchInicio.trim() && !batchRawList.trim())
                            }
                            onClick={async () => {
                              const created = await docs.registerSncrBatch({
                                modality: rxMeta.modality,
                                label: batchLabel,
                                inicio: batchInicio,
                                fim: batchFim,
                                rawList: batchRawList,
                              });
                              if (created) {
                                setBatchLabel('');
                                setBatchInicio('');
                                setBatchFim('');
                                setBatchRawList('');
                                if (!rxMeta.sncrNumber && created.nextNumber) {
                                  update({
                                    text: buildPrescriptionText({
                                      modality: rxMeta.modality,
                                      sncrNumber: created.nextNumber,
                                      viaAdmin: rxMeta.viaAdmin,
                                      bodyText: rxMeta.bodyText,
                                    }),
                                  });
                                }
                              }
                            }}
                          >
                            Salvar lote SNCR
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          );
        })()}
        <label>
          {d.kind === 'Receita'
            ? 'Data (opcional na impressão; preenchida ao assinar digitalmente)'
            : 'Data'}
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
                disabled={docs.busy || docs.signingDocId === d.id || !d.text.trim()}
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
                    `Deseja assinar digitalmente este documento com seu certificado ${signatureProviderLabel(docs.signatureSession.provider)} ICP-Brasil? Após a assinatura digital, o documento se tornará imutável e terá plena validade jurídica.`
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
