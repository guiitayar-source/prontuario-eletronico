'use client';
import { Upload } from 'lucide-react';
import { Modal } from '@/components/modal';
import { searchExams } from '@/lib/exams';
import { ExamChart } from './exam-chart';
import { ExamDefinitionForm, emptyField } from './exam-definition-form';
import { ExamProposalsSection } from './exam-proposals-section';
import { ExamResultForm, type Attachment } from './exam-result-form';
import { useExams, dateLabel } from './use-exams';

export default function Exams({
  patientId,
  attachments,
  onUploadAttachment,
}: {
  patientId: string;
  attachments: Attachment[];
  onUploadAttachment?: (file: File) => Promise<string | void>;
}) {
  const {
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
  } = useExams({ patientId, attachments, onUploadAttachment });
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
                    A IA prepara sugestões a partir do laudo anexado. Nada entra
                    no prontuário sem sua revisão e confirmação.
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
                          void handleExamUpload(
                            Array.from(e.target.files || []),
                          )
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
                  <code>OPENAI_API_KEY</code> no arquivo <code>.env.local</code>{' '}
                  para habilitar a extração real.
                </p>
              </div>
            )}
        </Modal>
      )}
    </section>
  );
}
