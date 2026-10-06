'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { Modal } from '@/components/modal';
import {
  proposalValues,
  type ExamExtractionProposal,
} from '@/lib/exam-extraction';
import {
  activeExamResults,
  searchExams,
  validateDefinition,
  validateResult,
  type ExamDefinition,
  type ExamField,
  type ExamResult,
  type ExamValue,
} from '@/lib/exams';
import { ExamChart } from './exams/exam-chart';
import { ExamDefinitionForm, emptyField } from './exams/exam-definition-form';
import { ExamProposalsSection } from './exams/exam-proposals-section';
import {
  ExamResultForm,
  type Attachment,
  type Draft,
  type Reviewing,
} from './exams/exam-result-form';
import './exams.css';

type AiModel = {
  id: 'openai-luna' | 'openai-mini' | 'demo';
  label: string;
  model: string;
  configured: boolean;
};
const dateLabel = (date: string) => date.split('-').reverse().join('/');

export default function Exams({
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
  return (
    <section className="exam-workspace" aria-label="Resultados de exames">
      <div className="exam-heading">
        <div>
          <h2>Resultados e evolução</h2>
          <p>
            Adicione exames conforme precisar. Os resultados ficam reunidos por
            paciente.
          </p>
        </div>
      </div>
      {loading ? (
        <output>Carregando resultados…</output>
      ) : (
        <>
          {!draft && !custom && (
            <>
              <section className="exam-ai" aria-labelledby="exam-ai-title">
                <div>
                  <h3 id="exam-ai-title">Preencher a partir do laudo</h3>
                  <p>
                    A IA prepara sugestões a partir do laudo anexado. Nada entra no
                    prontuário sem sua revisão e confirmação.
                  </p>
                </div>
                <div className="exam-actions">
                  {onUploadAttachment && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={uploading || extracting}
                        onClick={() => examFileInputRef.current?.click()}
                      >
                        <Upload size={16} />
                        {uploading ? progress : 'Anexar laudos'}
                      </button>
                      <input
                        ref={examFileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        multiple
                        hidden
                        onChange={(e) =>
                          void handleExamUpload(Array.from(e.target.files || []))
                        }
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={extracting || uploading || !chosenFiles.length}
                    onClick={() => void chooseProvider()}
                  >
                    {extracting
                      ? progress
                      : chosenFiles.length > 1
                        ? `Ler ${chosenFiles.length} laudos com IA`
                        : 'Ler com IA'}
                  </button>
                </div>
                {attachments.length ? (
                  <fieldset
                    className="exam-ai-files"
                    disabled={extracting || uploading}
                  >
                    <legend>
                      Laudos para leitura
                      {attachments.length > 1 && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setSelectedFiles(
                              chosenFiles.length === attachments.length
                                ? []
                                : attachments.map((item) => item.id),
                            )
                          }
                        >
                          {chosenFiles.length === attachments.length
                            ? 'Desmarcar todos'
                            : 'Marcar todos'}
                        </button>
                      )}
                    </legend>
                    {attachments.map((attachment) => (
                      <label key={attachment.id}>
                        <input
                          type="checkbox"
                          checked={chosenFiles.includes(attachment.id)}
                          onChange={() => toggleFile(attachment.id)}
                        />
                        <span>{attachment.name}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <small>
                    Anexe um ou mais laudos (PDF ou imagem) para leitura com IA.
                  </small>
                )}
              </section>
              {extractions.map((extraction) => (
                <ExamProposalsSection
                  key={extraction.attachmentId}
                  extraction={extraction}
                  fileName={fileName(extraction.attachmentId)}
                  definitions={definitions}
                  onDismiss={() =>
                    setExtractions((previous) =>
                      previous.filter((item) => item !== extraction),
                    )
                  }
                  onReviewProposal={(exam, index) =>
                    reviewProposal(extraction, exam, index)
                  }
                />
              ))}
              <div className="exam-search">
                <label htmlFor="exam-search">Adicionar exame manualmente</label>
                <div className="exam-actions">
                  <input
                    id="exam-search"
                    type="search"
                    placeholder="Busque hemograma, TSH, TGO…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button
                    className="secondary"
                    onClick={() => {
                      setCustom({
                        id: crypto.randomUUID(),
                        name: query.trim(),
                        aliases: [],
                        fields: [emptyField()],
                      });
                      setError('');
                    }}
                  >
                    Criar exame
                  </button>
                </div>
                {query.trim() && (
                  <div className="exam-search-results">
                    {searchExams(definitions, query).map((d) => (
                      <button key={d.id} onClick={() => start(d)}>
                        <strong>{d.name}</strong>
                        <small>
                          {d.fields.length > 1
                            ? `${d.fields.length} parâmetros`
                            : d.aliases.join(' · ')}
                        </small>
                      </button>
                    ))}
                    {!searchExams(definitions, query).length && (
                      <p>
                        Nenhum exame encontrado. Use “Criar exame” para
                        adicioná-lo à biblioteca da clínica.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {message && <output>{message}</output>}
          {custom && (
            <ExamDefinitionForm
              custom={custom}
              setCustom={setCustom}
              onSave={saveDefinition}
              busy={busy}
            />
          )}
          {draft && selected && (
            <ExamResultForm
              draft={draft}
              setDraft={setDraft}
              selected={selected}
              reviewing={reviewing}
              attachments={attachments}
              busy={busy}
              onSave={saveResult}
              onCancel={() => {
                setDraft(null);
                setReviewing(null);
              }}
              updateValue={updateValue}
            />
          )}
          {!used.length && !draft && !custom && (
            <p className="exam-empty">
              Busque um exame acima para começar o acompanhamento.
            </p>
          )}
          <div className="exam-list">
            {used.map((definition) => {
              const rows = current.filter(
                (r) => r.definition_id === definition.id,
              );
              return (
                <article key={definition.id} className="exam-summary">
                  <div>
                    <h3>{definition.name}</h3>
                    <small>
                      {rows.length} coleta(s) · última em{' '}
                      {dateLabel(rows[0].collected_on)}
                    </small>
                  </div>
                  <div className="exam-actions">
                    <button
                      className="secondary"
                      disabled={!!draft || !!custom}
                      onClick={() => start(definition)}
                    >
                      Novo resultado
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setHistory(
                          history === definition.id ? null : definition.id,
                        );
                        setGraph('');
                      }}
                    >
                      {history === definition.id
                        ? 'Fechar histórico'
                        : 'Histórico e gráfico'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {historyDefinition && (
            <section className="exam-history">
              <h3>Histórico · {historyDefinition.name}</h3>
              <div className="exam-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Parâmetro</th>
                      {historyResults.map((r) => (
                        <th key={r.id}>
                          {dateLabel(r.collected_on)}
                          <small>
                            {r.laboratory || 'Laboratório não informado'}
                          </small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyDefinition.fields
                      .filter((f) => historyResults.some((r) => r.values[f.id]))
                      .map((field) => (
                        <tr key={field.id}>
                          <th>
                            {field.name}
                            {field.type === 'number' && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  setGraph(graph === field.id ? '' : field.id)
                                }
                              >
                                Gráfico
                              </button>
                            )}
                          </th>
                          {historyResults.map((r) => (
                            <td key={r.id}>
                              {r.values[field.id] ? (
                                <>
                                  <strong>
                                    {r.values[field.id].value}{' '}
                                    {r.values[field.id].unit}
                                  </strong>
                                  <small>
                                    {r.values[field.id].reference &&
                                      `Referência: ${r.values[field.id].reference}`}
                                  </small>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {graph && (
                <div className="exam-graphs">
                  <h4>
                    {historyDefinition.fields.find((f) => f.id === graph)?.name}
                  </h4>
                  <p className="exam-help">
                    Resultados com &lt; ou &gt; ficam apenas na tabela. Datas e
                    valores exatos estão disponíveis no histórico.
                  </p>
                  <ExamChart
                    results={results}
                    definition={historyDefinition}
                    graph={graph}
                  />
                </div>
              )}
              <details>
                <summary>Detalhes das coletas e correções</summary>
                {results
                  .filter((r) => r.definition_id === history)
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((r) => (
                    <article className="exam-record-detail" key={r.id}>
                      <strong>
                        {dateLabel(r.collected_on)} ·{' '}
                        {current.some((c) => c.id === r.id)
                          ? 'Atual'
                          : 'Substituído por correção'}
                      </strong>
                      <p>
                        {[r.laboratory, r.specimen, r.method]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <p>
                        {Object.entries(r.values)
                          .map(
                            ([id, v]) =>
                              `${historyDefinition.fields.find((f) => f.id === id)?.name || id}: ${v.value} ${v.unit}${v.reference ? ` (ref. ${v.reference})` : ''}`,
                          )
                          .join(' · ')}
                      </p>
                      {r.notes && <p>{r.notes}</p>}
                      {r.correction_reason && (
                        <p>Motivo: {r.correction_reason}</p>
                      )}
                      {r.attachment_id && (
                        <p>
                          Laudo:{' '}
                          {attachments.find((a) => a.id === r.attachment_id)
                            ?.name || 'Anexo vinculado preservado no registro'}
                        </p>
                      )}
                      <small>
                        Registrado em{' '}
                        {new Date(r.created_at).toLocaleString('pt-BR')} ·
                        {r.source === 'ai_reviewed'
                          ? 'sugestão da IA revisada pelo profissional'
                          : 'preenchimento manual'}{' '}
                        · autor {r.author_id}
                      </small>
                      {current.some((c) => c.id === r.id) && (
                        <button
                          className="text-button"
                          disabled={!!draft || !!custom}
                          onClick={() => start(historyDefinition, r)}
                        >
                          Corrigir
                        </button>
                      )}
                    </article>
                  ))}
              </details>
            </section>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      {providerModal && (
        <Modal
          label="Escolher modelo de IA"
          className="exam-provider-modal"
          onClose={() => !extracting && setProviderModal(false)}
        >
          <button
            type="button"
            className="close text-button"
            aria-label="Fechar"
            onClick={() => setProviderModal(false)}
          >
            ×
          </button>
          <h2>
            {chosenFiles.length > 1
              ? `Escolha a IA para ler os ${chosenFiles.length} laudos`
              : 'Escolha a IA para ler o laudo'}
          </h2>
          <p>
            {chosenFiles.length > 1
              ? 'Os arquivos serão enviados'
              : 'O arquivo será enviado'}{' '}
            ao provedor escolhido. A leitura continuará como sugestão e
            precisará da sua revisão antes de ser salva.
          </p>
          {providerLoading ? (
            <output>Carregando modelos…</output>
          ) : (
            <div className="exam-provider-list">
              {models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  disabled={extracting}
                  className={model.configured ? 'configured' : 'unconfigured'}
                  onClick={() => {
                    if (!model.configured) {
                      setProviderKeyNote(
                        `Para usar ${model.label}, adicione OPENAI_API_KEY ao arquivo .env.local do servidor.`,
                      );
                      return;
                    }
                    void extractExams(model.id);
                  }}
                >
                  <span>
                    <strong>{model.label}</strong>
                    <small>{model.model}</small>
                  </span>
                  <span className="exam-provider-status">
                    {model.configured ? 'Usar modelo' : 'Não configurado'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {providerKeyNote && (
            <p className="exam-provider-warning" role="alert">
              {providerKeyNote}
            </p>
          )}
          {!providerLoading &&
            !models.some((item) => item.configured && item.id !== 'demo') && (
              <div className="exam-provider-note">
                <p>
                  <strong>Chaves de IA:</strong> Configure{' '}
                  <code>OPENAI_API_KEY</code> no
                  arquivo <code>.env.local</code> para habilitar a extração real.
                </p>
              </div>
            )}
        </Modal>
      )}
    </section>
  );
}
