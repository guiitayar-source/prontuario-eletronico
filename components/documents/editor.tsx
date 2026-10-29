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
import { Download, ShieldCheck, Key, Lock } from 'lucide-react';
import type { DocumentsController } from './use-documents';
import { DocumentAiBox } from './ai-box';
import { useFeature } from '../plan';
import { rceElectronicTemplate } from '@/lib/sncr/rce-fields';
import { notificationElectronicTemplate } from '@/lib/sncr/notification-fields';
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
  // Validação expirada com a página aberta: revalida direto no mesmo provedor.
  const expiredProvider = isSignatureProviderId(docs.signatureExpired)
    ? docs.signatureExpired
    : undefined;
  const d = docs.draft;
  if (!d) return null;
  const isSigned = d.status === 'SIGNED' || d.status === 'SUPERSEDED';
  const reservation=docs.numbering.reservation?.document_id===d.id ? docs.numbering.reservation : null;
  const controlled=d.kind==='Receita' && parsePrescriptionText(d.text).modality!=='simples';
  const simulated=!!d.signed_pdf_path?.includes('/sncr-simulations/');
  const local=docs.numbering.mode==='local-simulation';
  const frozen=isSigned || d.status==='SIGNING' || !!reservation;
  const reservationLabels={reserved:'reservada',signing:'assinatura em andamento',uncertain:'resultado incerto — reconciliação necessária',abandoned:'abandonada, com número preservado',signed:'simulação concluída'};
  const noun = prescription ? 'receita' : 'documento';

  function update(fields: Partial<ClinicalDocument>) {
    if (frozen) return;
    docs.setDraft({ ...d!, ...fields });
  }

  return (
    <>
      <h2 id="dialog-title">
        {simulated ? 'Simulação local — sem validade clínica' : isSigned
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
          <strong>{simulated ? 'SIMULAÇÃO LOCAL — SEM VALIDADE CLÍNICA' : '✓ Assinado Digitalmente • ICP-Brasil (PAdES)'}</strong>
          <p style={{ margin: '4px 0 0 0' }}>
            {simulated ? 'Artefato sintético assinado para teste local. Seu conteúdo é imutável.' : 'Assinatura conferida na emissão; a revogação do certificado ainda não é verificada pelo sistema (confira no validador do ITI). Seu conteúdo é imutável.'} Para realizar alterações, duplique-o como um novo rascunho.
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
      <fieldset disabled={docs.busy || frozen} style={{ border: 0, padding: 0 }}>
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
          return (
            <>
              <label htmlFor="prescription-modality">
                Modalidade da receita (Anvisa)
                <select
                  id="prescription-modality"
                  value={rxMeta.modality}
                  disabled={frozen}
                  onChange={(e) => {
                    const nextModality = e.target.value as PrescriptionModality;
                    if (nextModality !== rxMeta.modality && rxMeta.sncrNumber) {
                      window.alert('Esta receita já contém uma numeração SNCR. Revise e retire a numeração antes de mudar a modalidade; não reutilize o número em outra receita.');
                      return;
                    }
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
              {rxMeta.modality!=='simples' && <div style={{marginBottom:12}}>
                <label>Número vinculado
                  <input readOnly value={reservation?.number || rxMeta.sncrNumber} placeholder="Sem reserva" />
                </label>
                <p role="status">{docs.numbering.loading ? 'Consultando numeração…' : docs.numbering.error ? docs.numbering.error : reservation ? `Numeração ${reservationLabels[reservation.state]} · ${reservation.environment} · versão ${reservation.document_version}` : rxMeta.sncrNumber ? 'Número manual/histórico não verificado. Não autoriza emissão.' : local ? 'Simulação local disponível. Nenhum número reservado.' : 'Emissão controlada bloqueada até autenticação oficial SNCR/gov.br.'}</p>
                {local && <p>Estoque sintético disponível: {docs.sncrBatches.filter(b=>b.modality===rxMeta.modality).reduce((sum,b)=>sum+b.remaining,0)}</p>}
                {local && ['controle_especial','notificacao_a','notificacao_b','notificacao_b2'].includes(rxMeta.modality) && <p>
                  A simulação usa o formulário eletrônico próprio da Anvisa, com um medicamento por documento.
                  Preencha nome do medicamento ou substância, concentração, forma farmacêutica, quantidade e posologia com esses rótulos, além da via de administração.
                  Informe a data, CPF ou passaporte do paciente estrangeiro, endereço do paciente e endereço e telefone do prescritor antes de reservar.
                  Conteúdo que exceda o formulário bloqueia a assinatura; a reserva congela o rascunho.
                </p>}
                {local && ['notificacao_a','notificacao_b','notificacao_b2'].includes(rxMeta.modality) && <p>
                  O QR Code usa a consulta pública oficial da Anvisa para o número sintético desta simulação. Isso não valida nem autoriza a emissão real.
                </p>}
                {!reservation && <button type="button" className="secondary" disabled={!local || docs.numbering.loading || docs.busy} onClick={()=>void docs.requestSncrNumber()}>Reservar número sintético local</button>}
              </div>}
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
          {local && !frozen && d.kind === 'Receita' && parsePrescriptionText(d.text).modality === 'controle_especial' && (
            <button type="button" className="secondary" onClick={() => {
              // O texto anterior permanece visível para revisão humana. Não há
              // conversão automática nem substituição de conteúdo clínico.
              update({ text: rceElectronicTemplate + (d.text.trim() ? `\nTexto anterior para revisão do prescritor (remova este rótulo após conferir):\n${d.text}` : '') });
            }}>
              Inserir campos RCE eletrônica (simulação)
            </button>
          )}
          {local && !frozen && d.kind === 'Receita' && ['notificacao_a','notificacao_b','notificacao_b2'].includes(parsePrescriptionText(d.text).modality) && (
            <button type="button" className="secondary" onClick={() => {
              const rx = parsePrescriptionText(d.text);
              update({ text: buildPrescriptionText({ modality: rx.modality, viaAdmin: '[preencher]', bodyText: notificationElectronicTemplate.split('\n').slice(1).join('\n') + (rx.bodyText.trim() ? `\nTexto anterior para revisão do prescritor (remova este rótulo após conferir):\n${rx.bodyText}` : '') }) });
            }}>
              Inserir campos da Notificação eletrônica (simulação)
            </button>
          )}
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
              disabled={docs.busy || frozen}
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
            {controlled ? <>
              <button type="button" className="primary" disabled={docs.busy || !local || !reservation || reservation.state==='abandoned' || ((reservation.state==='uncertain'||reservation.state==='signing') && !reservation.artifact_metadata)} onClick={()=>void docs.sign(d.id)}>{reservation?.artifact_metadata ? 'Recuperar artefato simulado original' : 'Assinar simulação local (sem validade clínica)'}</button>
              {reservation && <button type="button" className="secondary" disabled={docs.busy} onClick={()=>docs.open(d,undefined,true)}>Duplicar como novo rascunho</button>}
            </> : d.status==='SIGNING' ? (
              <button type="button" className="primary" disabled={docs.busy} onClick={()=>void docs.sign(d.id)}>Consultar ou retomar assinatura</button>
            ) : !docs.signatureSession && choosingProvider ? (
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
            ? simulated ? 'Simulação local concluída (imutável)' : 'Documento assinado digitalmente (imutável)'
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
              ? simulated ? 'SIMULAÇÃO LOCAL — SEM VALIDADE CLÍNICA.' : 'PDF oficial com assinatura digital ICP-Brasil.'
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
