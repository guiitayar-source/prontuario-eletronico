import { useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { ClinicalDocument } from '@/lib/document-fields';
export type AiModel = {
  id: string;
  label: string;
  model: string;
  configured: boolean;
};
export type InstructionTemplate = {
  id: string;
  kind: string;
  name: string;
  instructions: string;
  updated_at?: string;
};
/** Estado e chamadas da IA de documentos: modelos, modelos de instrução e geração. */
export function useDocumentAi(
  d: ClinicalDocument,
  onApply: (text: string) => void,
) {
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

  return {
    open,
    setOpen,
    models,
    templates,
    modelId,
    setModelId,
    templateId,
    instructions,
    setInstructions,
    templateName,
    setTemplateName,
    showTemplateName,
    setShowTemplateName,
    setSavingAsNew,
    includeConsultation,
    setIncludeConsultation,
    includeClinicalContext,
    setIncludeClinicalContext,
    includeCurrentText,
    setIncludeCurrentText,
    proposal,
    setProposal,
    applyMode,
    setApplyMode,
    usage,
    usedModel,
    busy,
    loading,
    error,
    message,
    setMessage,
    matchingTemplates,
    toggle,
    selectTemplate,
    saveTemplate,
    deleteTemplate,
    generate,
    apply,
  };
}
