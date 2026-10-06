import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  proposalValues,
  type ExamExtractionProposal,
} from '@/lib/exam-extraction';
import {
  activeExamResults,
  validateDefinition,
  validateResult,
  type ExamDefinition,
  type ExamField,
  type ExamResult,
  type ExamValue,
} from '@/lib/exams';
import {
  type Attachment,
  type Draft,
  type Reviewing,
} from './exam-result-form';

type AiModel = {
  id: 'openai-luna' | 'openai-mini' | 'demo';
  label: string;
  model: string;
  configured: boolean;
};
export const dateLabel = (date: string) => date.split('-').reverse().join('/');

export function useExams({
  patientId,
  attachments,
  onUploadAttachment,
}: {
  patientId: string;
  attachments: Attachment[];
  onUploadAttachment?: (file: File) => Promise<string | void>;
}) {
  const [definitions, setDefinitions] = useState<ExamDefinition[]>([]);
  const [results, setResults] = useState<ExamResult[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [custom, setCustom] = useState<ExamDefinition | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [graph, setGraph] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [providerModal, setProviderModal] = useState(false);
  const [providerLoading, setProviderLoading] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [providerKeyNote, setProviderKeyNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const examFileInputRef = useRef<HTMLInputElement>(null);
  // Laudos marcados para a próxima leitura; cada um vira uma proposta própria.
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [extractions, setExtractions] = useState<ExamExtractionProposal[]>([]);
  const [progress, setProgress] = useState('');
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  const chosenFiles = selectedFiles.filter((id) =>
    attachments.some((attachment) => attachment.id === id),
  );
  const fileName = (id: string) =>
    attachments.find((attachment) => attachment.id === id)?.name || 'Arquivo';
  // O envio renova o pedido de captura a cada arquivo; no lote, usa sempre a
  // versão mais recente da função para não repetir um pedido já vencido.
  const uploadRef = useRef(onUploadAttachment);
  useEffect(() => {
    uploadRef.current = onUploadAttachment;
  }, [onUploadAttachment]);
  async function handleExamUpload(files: File[]) {
    if (!onUploadAttachment || !files.length) return;
    setError('');
    setMessage('');
    if (files.length > 10) {
      setError('Envie até 10 laudos por vez.');
      if (examFileInputRef.current) examFileInputRef.current.value = '';
      return;
    }
    setUploading(true);
    const added: string[] = [];
    const failed: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setProgress(
          files.length > 1
            ? `Enviando ${index + 1} de ${files.length}…`
            : 'Enviando laudo…',
        );
        try {
          const newId = await uploadRef.current?.(file);
          if (newId) added.push(newId);
        } catch (e) {
          failed.push(`${file.name}: ${(e as Error).message}`);
        }
      }
      if (added.length)
        setSelectedFiles((previous) => [...new Set([...previous, ...added])]);
      if (failed.length)
        setError(`Não foi possível anexar ${failed.join(' · ')}`);
    } finally {
      setUploading(false);
      setProgress('');
      if (examFileInputRef.current) examFileInputRef.current.value = '';
    }
  }
  function toggleFile(id: string) {
    setSelectedFiles((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }
  const endpoint = `/api/exams?patientId=${encodeURIComponent(patientId)}`;
  const call = useCallback(
    async (payload?: unknown) => {
      const response = await apiFetch(
        endpoint,
        payload
          ? {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Exams-Action': '1',
              },
              body: JSON.stringify(payload),
            }
          : undefined,
      );
      const data = (await response.json()) as {
        error?: string;
        definitions: ExamDefinition[];
        results: ExamResult[];
        record: ExamDefinition & ExamResult;
      };
      if (!response.ok)
        throw new Error(data.error || 'Não foi possível carregar os exames.');
      return data;
    },
    [endpoint],
  );
  useEffect(() => {
    let active = true;
    void call()
      .then((data) => {
        if (active) {
          setDefinitions(data.definitions);
          setResults(data.results);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [call]);
  function start(definition: ExamDefinition, correction?: ExamResult) {
    setDraft({
      id: crypto.randomUUID(),
      definition_id: definition.id,
      collected_on: correction?.collected_on || '',
      laboratory: correction?.laboratory || '',
      method: correction?.method || '',
      specimen: correction?.specimen || '',
      values: correction ? structuredClone(correction.values) : {},
      notes: correction?.notes || '',
      attachment_id: correction?.attachment_id || '',
      supersedes_id: correction?.id || null,
      correction_reason: '',
      source: 'manual',
      provenance: {},
    });
    setCustom(null);
    setQuery('');
    setMessage('');
    setError('');
  }
  async function chooseProvider() {
    if (!chosenFiles.length) return;
    setError('');
    setProviderKeyNote('');
    setProviderModal(true);
    setProviderLoading(true);
    try {
      const response = await apiFetch(
        `/api/ai-files?patientId=${encodeURIComponent(patientId)}`,
        { cache: 'no-store' },
      );
      const data = (await response.json()) as {
        models?: AiModel[];
        error?: string;
      };
      if (!response.ok || !data.models)
        throw new Error(
          data.error || 'Não foi possível carregar os modelos disponíveis.',
        );
      setModels(data.models);
    } catch (error) {
      setProviderModal(false);
      setError((error as Error).message);
    } finally {
      setProviderLoading(false);
    }
  }
  async function readFile(attachmentId: string, model: AiModel['id']) {
    const response = await apiFetch(
      `/api/ai-files?patientId=${encodeURIComponent(patientId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Action': '1',
        },
        body: JSON.stringify({ action: 'extract-exams', attachmentId, model }),
      },
    );
    const data = (await response.json()) as {
      proposal?: ExamExtractionProposal;
      error?: string;
    };
    if (!response.ok || !data.proposal)
      throw new Error(data.error || 'Não foi possível ler o exame.');
    return data.proposal;
  }
  async function extractExams(model: AiModel['id']) {
    const ids = chosenFiles;
    if (!ids.length) return;
    setProviderModal(false);
    setError('');
    setMessage('');
    setExtracting(true);
    setProgress(ids.length > 1 ? `Lendo 0 de ${ids.length}…` : 'Lendo laudo…');
    const read: ExamExtractionProposal[] = [];
    const failed: string[] = [];
    // Cada arquivo é uma chamada separada, com no máximo três ao mesmo tempo.
    const queue = [...ids];
    let done = 0;
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          read.push(await readFile(id, model));
        } catch (error) {
          failed.push(`${fileName(id)}: ${(error as Error).message}`);
        } finally {
          done += 1;
          if (ids.length > 1) setProgress(`Lendo ${done} de ${ids.length}…`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    read.sort(
      (a, b) => ids.indexOf(a.attachmentId) - ids.indexOf(b.attachmentId),
    );
    setExtractions((previous) => [
      ...previous.filter((item) => !ids.includes(item.attachmentId)),
      ...read,
    ]);
    // Os que falharam continuam marcados para tentar de novo.
    setSelectedFiles((previous) =>
      previous.filter((id) => !read.some((item) => item.attachmentId === id)),
    );
    if (read.length)
      setMessage(
        read.some((item) => item.exams.length)
          ? 'Leitura concluída. Revise cada sugestão antes de salvar.'
          : 'A leitura terminou, mas nenhum resultado foi identificado.',
      );
    if (failed.length) setError(`Não foi possível ler ${failed.join(' · ')}`);
    setExtracting(false);
    setProgress('');
  }
  function reviewProposal(
    extraction: ExamExtractionProposal,
    exam: ExamExtractionProposal['exams'][number],
    proposalIndex: number,
  ) {
    if (!exam.definitionId) return;
    const definition = definitions.find(
      (item) => item.id === exam.definitionId,
    );
    if (!definition) return;
    setDraft({
      id: crypto.randomUUID(),
      definition_id: definition.id,
      collected_on: exam.collectedOn || '',
      laboratory: exam.laboratory || '',
      method: exam.method || '',
      specimen: exam.specimen || '',
      values: proposalValues(exam, definition),
      notes: '',
      attachment_id: extraction.attachmentId,
      supersedes_id: null,
      correction_reason: '',
      source: 'ai_reviewed',
      provenance: {
        attachment_id: extraction.attachmentId,
        provider: extraction.provider,
        model: extraction.model,
        extracted_at: extraction.extractedAt,
      },
    });
    setReviewing({
      attachmentId: extraction.attachmentId,
      proposalIndex,
      originalName: exam.originalName,
      fields: exam.fields,
    });
    setCustom(null);
    setQuery('');
    setError('');
    setMessage('');
  }
  async function saveResult(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setError('');
    setBusy(true);
    try {
      const values = Object.fromEntries(
        Object.entries(draft.values).filter(([, v]) => v.value.trim()),
      );
      const payload = {
        ...draft,
        values,
        attachment_id: draft.attachment_id || null,
        provenance:
          draft.source === 'ai_reviewed'
            ? { ...draft.provenance, reviewed_at: new Date().toISOString() }
            : {},
      };
      validateResult(
        payload as ExamResult,
        definitions.find((d) => d.id === draft.definition_id)!,
      );
      const { record } = await call({ ...payload, action: 'result' });
      setResults((previous) => [...previous, record]);
      if (reviewing) {
        setExtractions((previous) =>
          previous.flatMap((item) => {
            if (item.attachmentId !== reviewing.attachmentId) return [item];
            const exams = item.exams.filter(
              (_, index) => index !== reviewing.proposalIndex,
            );
            return exams.length ? [{ ...item, exams }] : [];
          }),
        );
        setReviewing(null);
      }
      setDraft(null);
      setMessage(
        draft.source === 'ai_reviewed'
          ? 'Resultado revisado e salvo no histórico do paciente.'
          : 'Resultado salvo no histórico do paciente.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveDefinition(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!custom) return;
    setError('');
    setBusy(true);
    try {
      const cleaned = {
        ...custom,
        name: custom.name.trim(),
        aliases: custom.aliases.map((a) => a.trim()).filter(Boolean),
        fields: custom.fields.map((f) => ({
          ...f,
          name: f.name.trim(),
          options: f.options?.map((o) => o.trim()).filter(Boolean),
        })),
      };
      validateDefinition(cleaned);
      const { record } = await call({ ...cleaned, action: 'definition' });
      setDefinitions((previous) => [...previous, record]);
      setCustom(null);
      start(record);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const current = activeExamResults(results).sort(
    (a, b) =>
      b.collected_on.localeCompare(a.collected_on) ||
      b.created_at.localeCompare(a.created_at),
  );
  const used = definitions
    .filter((d) => results.some((r) => r.definition_id === d.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const selected = definitions.find((d) => d.id === draft?.definition_id);
  const historyDefinition = definitions.find((d) => d.id === history);
  const historyResults = current.filter((r) => r.definition_id === history);
  function updateValue(
    field: ExamField,
    property: keyof ExamValue,
    value: string,
  ) {
    setDraft(
      (previous) =>
        previous && {
          ...previous,
          values: {
            ...previous.values,
            [field.id]: {
              ...(previous.values[field.id] || {
                value: '',
                unit: field.unit,
                reference: '',
              }),
              [property]: value,
            },
          },
        },
    );
  }
  return {
    definitions,
    results,
    query,
    setQuery,
    draft,
    setDraft,
    custom,
    setCustom,
    history,
    setHistory,
    graph,
    setGraph,
    error,
    setError,
    message,
    loading,
    busy,
    extracting,
    providerModal,
    setProviderModal,
    providerLoading,
    models,
    providerKeyNote,
    setProviderKeyNote,
    uploading,
    examFileInputRef,
    setSelectedFiles,
    extractions,
    setExtractions,
    progress,
    reviewing,
    setReviewing,
    chosenFiles,
    fileName,
    handleExamUpload,
    toggleFile,
    start,
    chooseProvider,
    extractExams,
    reviewProposal,
    saveResult,
    saveDefinition,
    current,
    used,
    selected,
    historyDefinition,
    historyResults,
    updateValue,
  };
}
