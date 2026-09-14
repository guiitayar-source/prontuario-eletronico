'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  activeExamResults,
  examSeries,
  searchExams,
  validateDefinition,
  validateResult,
  type ExamDefinition,
  type ExamField,
  type ExamResult,
  type ExamValue,
} from '@/lib/exams';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import './exams.css';

type Attachment = { id: string; name: string };
type Draft = {
  id: string;
  definition_id: string;
  collected_on: string;
  laboratory: string;
  method: string;
  specimen: string;
  values: Record<string, ExamValue>;
  notes: string;
  attachment_id: string;
  supersedes_id: string | null;
  correction_reason: string;
};
const dateLabel = (date: string) => date.split('-').reverse().join('/');
const emptyField = (): ExamField => ({
  id: `f_${crypto.randomUUID().replaceAll('-', '')}`,
  name: '',
  type: 'number',
  unit: '',
});

export default function Exams({
  patientId,
  attachments,
}: {
  patientId: string;
  attachments: Attachment[];
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
    });
    setCustom(null);
    setQuery('');
    setMessage('');
    setError('');
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
      };
      validateResult(
        payload as ExamResult,
        definitions.find((d) => d.id === draft.definition_id)!,
      );
      const { record } = await call({ ...payload, action: 'result' });
      setResults((previous) => [...previous, record]);
      setDraft(null);
      setMessage('Resultado salvo no histórico do paciente.');
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
            <div className="exam-search">
              <label htmlFor="exam-search">Adicionar exame</label>
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
          )}
          {message && <output>{message}</output>}
          {custom && (
            <form onSubmit={saveDefinition} className="exam-editor">
              <h3>Novo exame da clínica</h3>
              <p>
                Defina os parâmetros uma vez para reutilizar em outros
                pacientes.
              </p>
              <div className="exam-meta">
                <label>
                  Nome
                  <input
                    required
                    maxLength={160}
                    value={custom.name}
                    onChange={(e) =>
                      setCustom({ ...custom, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Sinônimos (separados por vírgula)
                  <input
                    value={custom.aliases.join(',')}
                    onChange={(e) =>
                      setCustom({
                        ...custom,
                        aliases: e.target.value.split(','),
                      })
                    }
                  />
                </label>
              </div>
              {custom.fields.map((field, i) => (
                <div className="exam-custom-field" key={field.id}>
                  <label>
                    Parâmetro {i + 1}
                    <input
                      required
                      maxLength={120}
                      value={field.name}
                      onChange={(e) =>
                        setCustom({
                          ...custom,
                          fields: custom.fields.map((f) =>
                            f.id === field.id
                              ? { ...f, name: e.target.value }
                              : f,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Tipo
                    <select
                      aria-label="Tipo"
                      value={field.type}
                      onChange={(e) =>
                        setCustom({
                          ...custom,
                          fields: custom.fields.map((f) =>
                            f.id === field.id
                              ? {
                                  ...f,
                                  type: e.target.value as ExamField['type'],
                                }
                              : f,
                          ),
                        })
                      }
                    >
                      <option value="number">Número</option>
                      <option value="text">Texto</option>
                      <option value="choice">Opções</option>
                    </select>
                  </label>
                  {field.type === 'choice' ? (
                    <label>
                      Opções (separadas por vírgula)
                      <input
                        required
                        value={field.options?.join(',') || ''}
                        onChange={(e) =>
                          setCustom({
                            ...custom,
                            fields: custom.fields.map((f) =>
                              f.id === field.id
                                ? { ...f, options: e.target.value.split(',') }
                                : f,
                            ),
                          })
                        }
                      />
                    </label>
                  ) : (
                    <label>
                      Unidade sugerida
                      <input
                        maxLength={40}
                        value={field.unit}
                        onChange={(e) =>
                          setCustom({
                            ...custom,
                            fields: custom.fields.map((f) =>
                              f.id === field.id
                                ? { ...f, unit: e.target.value }
                                : f,
                            ),
                          })
                        }
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={custom.fields.length === 1 || busy}
                    onClick={() =>
                      setCustom({
                        ...custom,
                        fields: custom.fields.filter((f) => f.id !== field.id),
                      })
                    }
                  >
                    Remover
                  </button>
                </div>
              ))}
              <div className="exam-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={custom.fields.length >= 50 || busy}
                  onClick={() =>
                    setCustom({
                      ...custom,
                      fields: [...custom.fields, emptyField()],
                    })
                  }
                >
                  Adicionar parâmetro
                </button>
                <button className="primary" disabled={busy}>
                  Salvar modelo e preencher
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setCustom(null)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
          {draft && selected && (
            <form className="exam-editor" onSubmit={saveResult}>
              <h3>
                {draft.supersedes_id ? 'Corrigir resultado' : 'Novo resultado'}{' '}
                · {selected.name}
              </h3>
              <div className="exam-meta">
                <label>
                  Data da coleta
                  <input
                    type="date"
                    required
                    value={draft.collected_on}
                    onChange={(e) =>
                      setDraft({ ...draft, collected_on: e.target.value })
                    }
                  />
                </label>
                <label>
                  Laboratório
                  <input
                    maxLength={500}
                    value={draft.laboratory}
                    onChange={(e) =>
                      setDraft({ ...draft, laboratory: e.target.value })
                    }
                  />
                </label>
                <label>
                  Material
                  <input
                    maxLength={500}
                    placeholder="Conforme o laudo"
                    value={draft.specimen}
                    onChange={(e) =>
                      setDraft({ ...draft, specimen: e.target.value })
                    }
                  />
                </label>
                <label>
                  Método
                  <input
                    maxLength={500}
                    placeholder="Se informado"
                    value={draft.method}
                    onChange={(e) =>
                      setDraft({ ...draft, method: e.target.value })
                    }
                  />
                </label>
              </div>
              <p className="exam-help">
                Preencha apenas os resultados disponíveis. Confira as unidades
                no laudo; use números sem separador de milhar (ex.: 250000).
                Limites como &lt; 0,1 são aceitos.
              </p>
              {[
                ...new Set(selected.fields.map((f) => f.group || 'Resultados')),
              ].map((group) => (
                <fieldset key={group}>
                  <legend>{group}</legend>
                  {selected.fields
                    .filter((f) => (f.group || 'Resultados') === group)
                    .map((field) => (
                      <div className="exam-value-row" key={field.id}>
                        <label>
                          {field.name}
                          {field.type === 'choice' ? (
                            <select
                              aria-label={field.name}
                              value={draft.values[field.id]?.value || ''}
                              onChange={(e) =>
                                updateValue(field, 'value', e.target.value)
                              }
                            >
                              <option value="">Não informado</option>
                              {field.options?.map((o) => (
                                <option key={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              maxLength={2000}
                              placeholder="Não informado"
                              value={draft.values[field.id]?.value || ''}
                              onChange={(e) =>
                                updateValue(field, 'value', e.target.value)
                              }
                            />
                          )}
                        </label>
                        <label>
                          Unidade
                          <input
                            aria-label={`Unidade · ${field.name}`}
                            maxLength={40}
                            value={draft.values[field.id]?.unit ?? field.unit}
                            onChange={(e) =>
                              updateValue(field, 'unit', e.target.value)
                            }
                          />
                        </label>
                        <label>
                          Referência do laboratório
                          <input
                            aria-label={`Referência · ${field.name}`}
                            maxLength={500}
                            placeholder="Opcional"
                            value={draft.values[field.id]?.reference || ''}
                            onChange={(e) =>
                              updateValue(field, 'reference', e.target.value)
                            }
                          />
                        </label>
                      </div>
                    ))}
                </fieldset>
              ))}
              <div className="exam-meta">
                <label>
                  Laudo de origem
                  <select
                    value={draft.attachment_id}
                    onChange={(e) =>
                      setDraft({ ...draft, attachment_id: e.target.value })
                    }
                  >
                    <option value="">Sem anexo vinculado</option>
                    {draft.attachment_id &&
                      !attachments.some(
                        (a) => a.id === draft.attachment_id,
                      ) && (
                        <option value={draft.attachment_id}>
                          Anexo anterior indisponível — selecione outro ou
                          remova o vínculo
                        </option>
                      )}
                    {attachments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Observações
                  <textarea
                    maxLength={4000}
                    value={draft.notes}
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.target.value })
                    }
                  />
                </label>
              </div>
              {draft.supersedes_id && (
                <label>
                  Motivo da correção
                  <input
                    required
                    maxLength={500}
                    value={draft.correction_reason}
                    onChange={(e) =>
                      setDraft({ ...draft, correction_reason: e.target.value })
                    }
                  />
                  <small>O registro anterior será preservado.</small>
                </label>
              )}
              <div className="exam-actions">
                <button className="primary" disabled={busy}>
                  {busy ? 'Salvando…' : 'Salvar resultado'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  Cancelar
                </button>
              </div>
            </form>
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
                    Séries separadas por unidade, método, material e
                    laboratório. Resultados com &lt; ou &gt; ficam apenas na
                    tabela. Datas e valores exatos estão disponíveis no
                    histórico.
                  </p>
                  {examSeries(
                    results.filter((r) => r.definition_id === history),
                    graph,
                  ).map((series) => (
                    <div key={series.key}>
                      <p>{series.label}</p>
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart
                          data={series.points.map((p) => ({
                            ...p,
                            time: Date.parse(p.date),
                          }))}
                          margin={{ top: 10, right: 25, bottom: 10, left: 15 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="time"
                            type="number"
                            domain={['dataMin', 'dataMax']}
                            tickFormatter={(v) =>
                              dateLabel(new Date(v).toISOString().slice(0, 10))
                            }
                          />
                          <YAxis domain={['auto', 'auto']} />
                          <Tooltip
                            labelFormatter={(v) =>
                              dateLabel(
                                new Date(Number(v)).toISOString().slice(0, 10),
                              )
                            }
                          />
                          <Line
                            name="Resultado"
                            type="linear"
                            dataKey="value"
                            stroke="var(--exam-accent, #537d98)"
                            strokeWidth={2}
                            dot={{ r: 4 }}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ))}
                  {!examSeries(
                    results.filter((r) => r.definition_id === history),
                    graph,
                  ).length && (
                    <p>
                      Nenhum valor numérico exato disponível para o gráfico.
                    </p>
                  )}
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
                        preenchimento manual · autor {r.author_id}
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
    </section>
  );
}
