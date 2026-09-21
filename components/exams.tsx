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
  id: 'gemini-flash' | 'openai-luna' | 'openai-mini' | 'demo';
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
  const [extractionAttachment, setExtractionAttachment] = useState('');
  const [extraction, setExtraction] = useState<ExamExtractionProposal | null>(
    null,
  );
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);

  async function handleExamUpload(file: File) {
    if (!onUploadAttachment) return;
    setError('');
    setMessage('');
    setUploading(true);
    try {
      const newId = await onUploadAttachment(file);
      if (newId) {
        setExtractionAttachment(newId);
        setExtraction(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (examFileInputRef.current) examFileInputRef.current.value = '';
    }
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
    if (!extractionAttachment) return;
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
  async function extractExams(model: AiModel['id']) {
    if (!extractionAttachment) return;
    setProviderModal(false);
    setError('');
    setMessage('');
    setExtracting(true);
    try {
      const response = await apiFetch(
        `/api/ai-files?patientId=${encodeURIComponent(patientId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AI-Action': '1',
          },
          body: JSON.stringify({
            action: 'extract-exams',
            attachmentId: extractionAttachment,
            model,
          }),
        },
      );
      const data = (await response.json()) as {
        proposal?: ExamExtractionProposal;
        error?: string;
      };
      if (!response.ok || !data.proposal)
        throw new Error(data.error || 'Não foi possível ler o exame.');
      setExtraction(data.proposal);
      setMessage(
        data.proposal.exams.length
          ? 'Leitura concluída. Revise cada sugestão antes de salvar.'
          : 'A leitura terminou, mas nenhum resultado foi identificado.',
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setExtracting(false);
    }
  }
  function reviewProposal(
    exam: ExamExtractionProposal['exams'][number],
    proposalIndex: number,
  ) {
    if (!extraction || !exam.definitionId) return;
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
      if (reviewing && extraction) {
        const remaining = extraction.exams.filter(
          (_, index) => index !== reviewing.proposalIndex,
        );
        setExtraction(
          remaining.length ? { ...extraction, exams: remaining } : null,
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
                        {uploading ? 'Enviando laudo…' : 'Anexar laudo'}
                      </button>
                      <input
                        ref={examFileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleExamUpload(file);
                        }}
                      />
                    </>
                  )}
                  <label>
                    Laudo anexado
                    <select
                      value={extractionAttachment}
                      disabled={extracting || uploading || !attachments.length}
                      onChange={(event) => {
                        setExtractionAttachment(event.target.value);
                        setExtraction(null);
                      }}
                    >
                      <option value="">
                        {attachments.length
                          ? 'Selecione um arquivo'
                          : 'Nenhum laudo anexado'}
                      </option>
                      {attachments.map((attachment) => (
                        <option key={attachment.id} value={attachment.id}>
                          {attachment.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="primary"
                    disabled={extracting || uploading || !extractionAttachment}
                    onClick={() => void chooseProvider()}
                  >
                    {extracting ? 'Lendo laudo…' : 'Ler com IA'}
                  </button>
                </div>
                {!attachments.length && (
                  <small>
                    Anexe um laudo (PDF ou imagem) ou selecione um arquivo para leitura com IA.
                  </small>
                )}
              </section>
              {extraction && (
                <ExamProposalsSection
                  extraction={extraction}
                  definitions={definitions}
                  onDismiss={() => setExtraction(null)}
                  onReviewProposal={(exam, index) => reviewProposal(exam, index)}
                />
              )}
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
          <h2>Escolha a IA para ler o laudo</h2>
          <p>
            O arquivo será enviado ao provedor escolhido. A leitura continuará
            como sugestão e precisará da sua revisão antes de ser salva.
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
                      const keyName =
                        model.id === 'gemini-flash'
                          ? 'GEMINI_API_KEY'
                          : 'OPENAI_API_KEY';
                      setProviderKeyNote(
                        `Para usar ${model.label}, adicione ${keyName} ao arquivo .env.local do servidor.`,
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
                  <code>GEMINI_API_KEY</code> ou <code>OPENAI_API_KEY</code> no
                  arquivo <code>.env.local</code> para habilitar a extração real.
                </p>
                <p>
                  Você pode usar a opção{' '}
                  <strong>Demonstração · Simulação Local</strong> para testar a
                  extração e o preenchimento de exames agora mesmo.
                </p>
              </div>
            )}
        </Modal>
      )}
    </section>
  );
}
