'use client';
import { useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { ClinicalDocument } from '@/lib/document-fields';
import { Sparkles, Trash2 } from 'lucide-react';
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
export function DocumentAiBox({
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
