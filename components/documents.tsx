'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  documentKinds,
  documentTemplate,
  type ClinicalDocument,
} from '@/lib/document-fields';
import type { Patient } from '@/lib/patient-fields';
import { Sparkles, Trash2, Download, ShieldCheck, Key, Lock, CheckCircle2, AlertCircle } from 'lucide-react';
import type { SignatureSessionData } from '@/lib/signature/types';
type Profile = {
  physician_name: string;
  physician_registration: string;
  cpf?: string | null;
};
type AiModel = {
  id: string;
  label: string;
  model: string;
  configured: boolean;
};
type InstructionTemplate = {
  id: string;
  kind: string;
  name: string;
  instructions: string;
  updated_at?: string;
};
export function useDocuments(patient: Patient, enabled = true) {
  const [rows, setRows] = useState<ClinicalDocument[]>([]),
    [profile, setProfile] = useState<Profile>({
      physician_name: '',
      physician_registration: '',
      cpf: null,
    }),
    [draft, setDraft] = useState<ClinicalDocument | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(''),
    [preview, setPreview] = useState(''),
    [signatureSession, setSignatureSession] = useState<SignatureSessionData | null>(null),
    [signatureNotice, setSignatureNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null),
    [signingDocId, setSigningDocId] = useState<string | null>(null);
  const previewRef = useRef(''),
    saving = useRef(false);

  async function checkSignatureSession() {
    try {
      const r = await apiFetch('/api/digital-signature/session');
      if (r.ok) {
        const data = (await r.json()) as { active: boolean; session: SignatureSessionData | null };
        setSignatureSession(data.active ? data.session : null);
      }
    } catch {
      // Ignore background check failure
    }
  }

  async function connectBirdId() {
    try {
      setError('');
      if (typeof window !== 'undefined' && patient?.id) {
        sessionStorage.setItem('birdid_return_patient_id', patient.id);
        sessionStorage.setItem('birdid_return_tab', 'documentos');
      }
      const r = await apiFetch('/api/digital-signature/birdid/authorize');
      const data = (await r.json()) as { authorizationUrl?: string; error?: string };
      if (!r.ok) throw new Error(data.error || 'Falha ao iniciar autenticação Bird ID');
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnectBirdId() {
    try {
      await apiFetch('/api/digital-signature/session', { method: 'DELETE' });
      setSignatureSession(null);
      setSignatureNotice({
        type: 'success',
        message: 'Sessão Bird ID desconectada.',
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function signTestDocument() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/digital-signature/test-sign', {
        method: 'POST',
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        storagePath?: string;
        verification?: { isValid: boolean; signerName: string; signerCpf: string; algorithm: string };
      };
      if (!res.ok) throw new Error(data.error || 'Falha ao testar assinatura');

      setSignatureNotice({
        type: 'success',
        message: `✓ Documento sintético assinado com sucesso! Titular: ${data.verification?.signerName} (${data.verification?.signerCpf}).`,
      });

      if (data.storagePath) {
        window.open(
          `/api/digital-signature/test-sign?path=${encodeURIComponent(data.storagePath)}`,
          '_blank'
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const r = await apiFetch(
      '/api/documents?patientId=' + encodeURIComponent(patient.id),
    );
    const data = (await r.json()) as {
      documents: ClinicalDocument[];
      profile: Profile | null;
      error?: string;
    };
    if (!r.ok) throw new Error(data.error);
    setRows(data.documents);
    if (data.profile) setProfile(data.profile);
  }
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const sigStatus = params.get('signature_status');
      const sigError = params.get('signature_error');
      if (sigStatus === 'connected') {
        queueMicrotask(() => {
          setSignatureNotice({
            type: 'success',
            message: '✓ Certificado digital Bird ID conectado com sucesso para esta sessão!',
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      } else if (sigError) {
        queueMicrotask(() => {
          setSignatureNotice({
            type: 'error',
            message: `Falha na conexão Bird ID: ${sigError}`,
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    void checkSignatureSession();
  }, []);

  useEffect(() => {
    if (enabled) void load().catch((e) => setError(e.message));
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [patient.id, enabled]);
  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
    setPreview('');
  }
  function open(
    d?: ClinicalDocument,
    consultationId?: string,
    duplicate = false,
    initialText = '',
  ) {
    clearPreview();
    setError('');
    const next = d
      ? {
          ...d,
          ...(duplicate
            ? {
                id: crypto.randomUUID(),
                version: 0,
                author_id: undefined,
                updated_at: undefined,
              }
            : {}),
        }
      : {
          id: crypto.randomUUID(),
          patient_id: patient.id,
          consultation_id: consultationId || null,
          kind: documentKinds[0],
          patient_name: patient.social_name || patient.name,
          ...profile,
          document_date: new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
          }).format(new Date()),
          text: initialText,
          version: 0,
        };
    setDraft(next);
    setSaved(JSON.stringify(next));
  }
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  function close() {
    if (busy) return false;
    if (
      dirty &&
      !window.confirm('Descartar as alterações não salvas deste documento?')
    )
      return false;
    setDraft(null);
    clearPreview();
    return true;
  }
  async function save() {
    if (!draft || saving.current) return null;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-Action': '1',
        },
        body: JSON.stringify(draft),
      });
      const result = (await r.json()) as {
        document: ClinicalDocument;
        error?: string;
      };
      if (!r.ok) throw new Error(result.error);
      setDraft(result.document);
      setSaved(JSON.stringify(result.document));
      await load();
      return result.document;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function pdf() {
    const d = dirty || draft?.version === 0 ? await save() : draft;
    if (!d) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(
        `/api/documents?action=pdf&patientId=${encodeURIComponent(patient.id)}&id=${d.id}`,
      );
      if (!r.ok) {
        const e = (await r.json()) as { error: string };
        throw new Error(e.error);
      }
      clearPreview();
      previewRef.current = URL.createObjectURL(await r.blob());
      setPreview(previewRef.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sign(documentId: string) {
    if (!signatureSession) {
      setError('Conecte sua conta Bird ID antes de assinar o documento.');
      return false;
    }
    let currentDoc = draft;
    if (dirty || currentDoc?.version === 0) {
      currentDoc = await save();
      if (!currentDoc) return false;
    }
    setBusy(true);
    setSigningDocId(documentId);
    setError('');
    try {
      const res = await apiFetch('/api/digital-signature/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Action': '1',
        },
        body: JSON.stringify({ documentId }),
      });
      const data = (await res.json()) as { error?: string; signedPdfPath?: string };
      if (!res.ok) throw new Error(data.error || 'Falha ao assinar documento');

      setSignatureNotice({
        type: 'success',
        message: '✓ Documento assinado digitalmente com sucesso (ICP-Brasil)!',
      });
      await load();
      if (draft && draft.id === documentId) {
        setDraft({ ...draft, status: 'SIGNED', signed_pdf_path: data.signedPdfPath });
        await pdf();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      setSigningDocId(null);
    }
  }

  return {
    rows,
    draft,
    setDraft: (d: ClinicalDocument) => {
      clearPreview();
      setDraft(d);
    },
    error,
    busy,
    dirty,
    preview,
    signatureSession,
    signatureNotice,
    signingDocId,
    connectBirdId,
    disconnectBirdId,
    signTestDocument,
    sign,
    load,
    open,
    close,
    save,
    pdf,
  };
}
export type DocumentsController = ReturnType<typeof useDocuments>;
export function DocumentHistory({
  docs,
  onOpen,
}: {
  docs: DocumentsController;
  onOpen: (d: ClinicalDocument, duplicate?: boolean) => void;
}) {
  return (
    <section className="history-card">
      <div className="card-heading">
        <span>Documentos salvos</span>
        <button
          className="text-button"
          onClick={() => void docs.load().catch(() => {})}
        >
          Atualizar
        </button>
      </div>
      {docs.error && !docs.draft && <p role="alert">{docs.error}</p>}
      {!docs.rows.length && (
        <p className="muted">Nenhum documento salvo para este paciente.</p>
      )}
      {docs.rows.map((d) => (
        <div className="consultation-history-link" key={d.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <strong>{d.kind}</strong>
            {d.status === 'SIGNED' ? (
              <span style={{ backgroundColor: '#e6f4ea', color: '#137333', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={12} /> Assinado ICP-Brasil
              </span>
            ) : d.status === 'SIGNING' ? (
              <span style={{ backgroundColor: '#fef7e0', color: '#b06000', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                ⏳ Assinando...
              </span>
            ) : d.status === 'SIGNATURE_FAILED' ? (
              <span style={{ backgroundColor: '#fce8e6', color: '#c5221f', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <AlertCircle size={12} /> Falha na assinatura
              </span>
            ) : (
              <span style={{ backgroundColor: '#f1f3f4', color: '#5f6368', fontSize: '11px', padding: '2px 8px', borderRadius: '12px' }}>
                Rascunho
              </span>
            )}
          </div>
          <span>
            {(d.document_date ? d.document_date.split('-').reverse().join('/') : 'Sem data')} · versão{' '}
            {d.version}
            {d.consultation_id ? ' · Vinculado à consulta' : ''}
          </span>
          <div>
            <button className="text-button" onClick={() => onOpen(d)}>
              {d.status === 'SIGNED' ? 'Visualizar' : 'Abrir'}
            </button>{' '}
            ·{' '}
            <button className="text-button" onClick={() => onOpen(d, true)}>
              Duplicar
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function DocumentAiBox({
  document: d,
  onApply,
}: {
  document: ClinicalDocument;
  onApply: (text: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [models, setModels] = useState<AiModel[]>([]),
    [templates, setTemplates] = useState<InstructionTemplate[]>([]),
    [modelId, setModelId] = useState(''),
    [templateId, setTemplateId] = useState(''),
    [instructions, setInstructions] = useState(''),
    [templateName, setTemplateName] = useState(''),
    [showTemplateName, setShowTemplateName] = useState(false),
    [savingAsNew, setSavingAsNew] = useState(false),
    [includeConsultation, setIncludeConsultation] = useState(
      Boolean(d.consultation_id),
    ),
    [includeClinicalContext, setIncludeClinicalContext] = useState(true),
    [includeCurrentText, setIncludeCurrentText] = useState(
      Boolean(d.text.trim()),
    ),
    [proposal, setProposal] = useState(''),
    [applyMode, setApplyMode] = useState<'replace' | 'append'>('replace'),
    [usage, setUsage] = useState<{
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    } | null>(null),
    [usedModel, setUsedModel] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');

  const matchingTemplates = templates.filter((item) => item.kind === d.kind);

  async function loadOptions() {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/document-ai');
      const result = (await response.json()) as {
        models: AiModel[];
        templates: InstructionTemplate[];
        error?: string;
      };
      if (!response.ok) throw new Error(result.error);
      setModels(result.models);
      setTemplates(result.templates);
      const stored = window.localStorage.getItem('psywrite-document-ai-model');
      const selected = result.models.find(
        (item) => item.configured && item.id === stored,
      );
      setModelId(
        selected?.id || result.models.find((item) => item.configured)?.id || '',
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    setMessage('');
    if (next && !models.length && !loading) void loadOptions();
  }

  function selectTemplate(id: string) {
    setTemplateId(id);
    setMessage('');
    const template = templates.find((item) => item.id === id);
    if (template) {
      setInstructions(template.instructions);
      setTemplateName(template.name);
    } else {
      setTemplateName('');
    }
  }

  async function saveTemplate() {
    if (!templateName.trim() || !instructions.trim()) {
      setError('Preencha o nome e as instruções antes de salvar o modelo.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const id = templateId && !savingAsNew ? templateId : crypto.randomUUID();
      const response = await apiFetch('/api/document-ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-AI-Action': '1',
        },
        body: JSON.stringify({
          action: 'save-template',
          id,
          kind: d.kind,
          name: templateName,
          instructions,
        }),
      });
      const result = (await response.json()) as {
        template: InstructionTemplate;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error);
      setTemplates((current) =>
        [...current.filter((item) => item.id !== id), result.template].sort(
          (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
        ),
      );
      setTemplateId(id);
      setTemplateName(result.template.name);
      setShowTemplateName(false);
      setSavingAsNew(false);
      setMessage('Modelo de instruções salvo.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate() {
    const selected = templates.find((item) => item.id === templateId);
    if (!selected) return;
    if (!window.confirm(`Excluir o modelo “${selected.name}”?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch('/api/document-ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-AI-Action': '1',
        },
        body: JSON.stringify({ action: 'delete-template', id: templateId }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error);
      setTemplates((current) =>
        current.filter((item) => item.id !== templateId),
      );
      setTemplateId('');
      setTemplateName('');
      setSavingAsNew(false);
      setMessage('Modelo excluído.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError('');
    setMessage('');
    setProposal('');
    setUsage(null);
    try {
      const response = await apiFetch('/api/document-ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-AI-Action': '1',
        },
        body: JSON.stringify({
          action: 'generate',
          patientId: d.patient_id,
          consultationId: d.consultation_id,
          kind: d.kind,
          documentDate: d.document_date || '',
          modelId,
          instructions,
          includeConsultation:
            Boolean(d.consultation_id) && includeConsultation,
          includeClinicalContext,
          currentText: includeCurrentText ? d.text : '',
        }),
      });
      const result = (await response.json()) as {
        draft: string;
        model: { label: string };
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        error?: string;
      };
      if (!response.ok) throw new Error(result.error);
      setProposal(result.draft);
      setUsage(result.usage || null);
      setUsedModel(result.model.label);
      setApplyMode('replace');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    const next =
      applyMode === 'append' && d.text.trim()
        ? `${d.text.trim()}\n\n${proposal.trim()}`
        : proposal.trim();
    onApply(next);
    setMessage('Rascunho inserido no documento. Revise antes de salvar.');
  }

  return (
    <div className="document-ai">
      <button
        className="secondary document-ai-trigger"
        onClick={toggle}
        type="button"
      >
        <Sparkles size={15} /> Criar com IA
      </button>
      {open && (
        <section className="document-ai-box" aria-label="Criar rascunho com IA">
          <div className="document-ai-heading">
            <div>
              <strong>Criar rascunho com IA</strong>
              <span>
                Você escolhe o que será enviado e revisa antes de salvar.
              </span>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => setOpen(false)}
            >
              Recolher
            </button>
          </div>

          {loading ? (
            <p className="muted">Carregando modelos…</p>
          ) : (
            <>
              <div className="document-ai-grid">
                <label>
                  Modelo de instruções
                  <select
                    value={templateId}
                    onChange={(event) => selectTemplate(event.target.value)}
                  >
                    <option value="">Sem modelo salvo</option>
                    {matchingTemplates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Modelo de IA
                  <select
                    value={modelId}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      window.localStorage.setItem(
                        'psywrite-document-ai-model',
                        event.target.value,
                      );
                    }}
                  >
                    {!modelId && (
                      <option value="">Nenhum modelo configurado</option>
                    )}
                    {models.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.configured}
                      >
                        {item.label}
                        {item.configured ? '' : ' · não configurado'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                Instruções para este documento
                <textarea
                  className="document-ai-instructions"
                  maxLength={12000}
                  placeholder="Ex.: escreva um relatório conciso para continuidade do tratamento, destacando evolução e conduta."
                  value={instructions}
                  onChange={(event) => {
                    setInstructions(event.target.value);
                    setMessage('');
                  }}
                />
              </label>

              <div className="document-template-actions">
                {!showTemplateName ? (
                  <div className="document-template-choices">
                    {templateId && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={!instructions.trim() || busy}
                        onClick={() => {
                          setSavingAsNew(false);
                          setShowTemplateName(true);
                        }}
                      >
                        Atualizar modelo
                      </button>
                    )}
                    <button
                      className="text-button"
                      type="button"
                      disabled={!instructions.trim() || busy}
                      onClick={() => {
                        setSavingAsNew(true);
                        setTemplateName('');
                        setShowTemplateName(true);
                      }}
                    >
                      Salvar como novo modelo
                    </button>
                  </div>
                ) : (
                  <div className="document-template-save">
                    <input
                      aria-label="Nome do modelo de instruções"
                      maxLength={80}
                      placeholder="Nome do modelo"
                      value={templateName}
                      onChange={(event) => setTemplateName(event.target.value)}
                    />
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void saveTemplate()}
                    >
                      Salvar
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setShowTemplateName(false);
                        setSavingAsNew(false);
                        setTemplateName(
                          templates.find((item) => item.id === templateId)
                            ?.name || '',
                        );
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                {templateId && (
                  <button
                    className="text-button danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteTemplate()}
                  >
                    <Trash2 size={14} /> Excluir modelo
                  </button>
                )}
              </div>
              <p className="document-template-note">
                Os modelos ficam na sua conta. Salve somente orientações
                reutilizáveis, sem informações de pacientes.
              </p>

              <fieldset className="document-ai-context">
                <legend>Contexto enviado</legend>
                <p>
                  Nome do paciente, tipo e data do documento são sempre
                  enviados.
                </p>
                {d.consultation_id && (
                  <label>
                    <input
                      type="checkbox"
                      checked={includeConsultation}
                      onChange={(event) =>
                        setIncludeConsultation(event.target.checked)
                      }
                    />
                    Consulta vinculada e seus adendos
                  </label>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={includeClinicalContext}
                    onChange={(event) =>
                      setIncludeClinicalContext(event.target.checked)
                    }
                  />
                  Condições, medicamentos e alergias atuais
                </label>
                {d.text.trim() && (
                  <label>
                    <input
                      type="checkbox"
                      checked={includeCurrentText}
                      onChange={(event) =>
                        setIncludeCurrentText(event.target.checked)
                      }
                    />
                    Texto já escrito neste documento
                  </label>
                )}
              </fieldset>

              {error && (
                <div className="capture-error" role="alert">
                  {error}
                </div>
              )}
              {message && (
                <output className="document-ai-message">{message}</output>
              )}

              <button
                className="primary document-ai-generate"
                type="button"
                disabled={busy || !modelId}
                onClick={() => void generate()}
              >
                <Sparkles size={15} />{' '}
                {busy
                  ? 'Gerando rascunho…'
                  : proposal
                    ? 'Gerar novamente'
                    : 'Gerar rascunho'}
              </button>

              {proposal && (
                <div className="document-ai-result">
                  <div className="document-ai-result-meta">
                    <strong>Rascunho gerado</strong>
                    <span>
                      {usedModel}
                      {usage?.totalTokens
                        ? ` · ${usage.totalTokens.toLocaleString('pt-BR')} tokens`
                        : ''}
                    </span>
                  </div>
                  <textarea
                    aria-label="Rascunho gerado pela IA"
                    value={proposal}
                    onChange={(event) => setProposal(event.target.value)}
                  />
                  {d.text.trim() && (
                    <div className="document-ai-apply-mode">
                      <span>Ao inserir:</span>
                      <label>
                        <input
                          type="radio"
                          name={`ai-apply-${d.id}`}
                          checked={applyMode === 'replace'}
                          onChange={() => setApplyMode('replace')}
                        />
                        Substituir o texto atual
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`ai-apply-${d.id}`}
                          checked={applyMode === 'append'}
                          onChange={() => setApplyMode('append')}
                        />
                        Acrescentar ao final
                      </label>
                    </div>
                  )}
                  <button
                    className="secondary"
                    type="button"
                    disabled={!proposal.trim()}
                    onClick={apply}
                  >
                    Inserir no documento
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function DocumentEditor({ docs }: { docs: DocumentsController }) {
  const d = docs.draft;
  if (!d) return null;
  const isSigned = d.status === 'SIGNED';

  function update(fields: Partial<ClinicalDocument>) {
    if (isSigned) return;
    docs.setDraft({ ...d!, ...fields });
  }

  return (
    <>
      <h2 id="dialog-title">
        {isSigned
          ? 'Documento assinado digitalmente'
          : d.version
            ? 'Editar documento'
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
              docs.signatureNotice.type === 'success' ? '#e6f4ea' : '#fce8e6',
            color:
              docs.signatureNotice.type === 'success' ? '#137333' : '#c5221f',
            border: `1px solid ${
              docs.signatureNotice.type === 'success' ? '#ceead6' : '#fad2cf'
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
            backgroundColor: '#e6f4ea',
            border: '1px solid #ceead6',
            borderRadius: '6px',
            marginBottom: '16px',
            color: '#137333',
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
            backgroundColor: docs.signatureSession ? '#f0f7ff' : '#f8f9fa',
            border: `1px solid ${docs.signatureSession ? '#c2e0ff' : '#dadce0'}`,
            borderRadius: '6px',
            marginBottom: '16px',
            fontSize: '13px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {docs.signatureSession ? (
              <ShieldCheck size={18} color="#0b66c2" />
            ) : (
              <Key size={18} color="#5f6368" />
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
                backgroundColor: docs.signatureSession ? '#0d652d' : undefined,
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
          color: '#5f6368',
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
            style={{ width: '100%', height: 440, border: '1px solid #ddd' }}
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
