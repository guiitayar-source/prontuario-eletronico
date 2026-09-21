'use client';
import type { ExamDefinition, ExamField, ExamValue } from '@/lib/exams';
import type { ExamExtractionProposal } from '@/lib/exam-extraction';

export type Attachment = { id: string; name: string };

export type Draft = {
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
  source: 'manual' | 'ai_reviewed';
  provenance: Record<string, unknown>;
};

export type Reviewing = {
  proposalIndex: number;
  originalName: string;
  fields: ExamExtractionProposal['exams'][number]['fields'];
};

export type ExamResultFormProps = {
  draft: Draft;
  setDraft: (d: Draft) => void;
  selected: ExamDefinition;
  reviewing: Reviewing | null;
  attachments: Attachment[];
  busy: boolean;
  onSave: (event: React.SyntheticEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
  updateValue: (
    field: ExamField,
    key: 'value' | 'unit' | 'reference',
    value: string,
  ) => void;
};

export function ExamResultForm({
  draft,
  setDraft,
  selected,
  reviewing,
  attachments,
  busy,
  onSave,
  onCancel,
  updateValue,
}: ExamResultFormProps) {
  return (
    <form className="exam-editor" onSubmit={onSave}>
      <h3>
        {draft.supersedes_id ? 'Corrigir resultado' : 'Novo resultado'} ·{' '}
        {selected.name}
      </h3>
      {reviewing && (
        <output className="exam-ai-review">
          <strong>Revisão obrigatória da sugestão</strong>
          <p>
            Confira o laudo original, a data, cada valor, unidade e referência.
            O sistema só salvará depois de sua confirmação.
          </p>
          <small>Identificado no arquivo como: {reviewing.originalName}</small>
        </output>
      )}
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
            onChange={(e) => setDraft({ ...draft, specimen: e.target.value })}
          />
        </label>
        <label>
          Método
          <input
            maxLength={500}
            placeholder="Se informado"
            value={draft.method}
            onChange={(e) => setDraft({ ...draft, method: e.target.value })}
          />
        </label>
      </div>
      <p className="exam-help">
        Preencha apenas os resultados disponíveis. Confira as unidades no laudo;
        use números sem separador de milhar (ex.: 250000). Limites como &lt; 0,1
        são aceitos.
      </p>
      {[
        ...new Set(selected.fields.map((f) => f.group || 'Resultados')),
      ].map((group) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {selected.fields
            .filter((f) => (f.group || 'Resultados') === group)
            .map((field) => {
              const evidence = reviewing?.fields.find(
                (item) => item.fieldId === field.id,
              );
              return (
                <div className="exam-value-block" key={field.id}>
                  <div className="exam-value-row">
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
                  {evidence && (
                    <div className="exam-evidence">
                      <strong>
                        Trecho de origem
                        {evidence.page ? ` · página ${evidence.page}` : ''}
                      </strong>
                      <span>
                        {evidence.originalText || 'Trecho não informado.'}
                      </span>
                      {evidence.warnings.map((warning, index) => (
                        <span key={`${warning}-${index}`}>
                          Atenção: {warning}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
              !attachments.some((a) => a.id === draft.attachment_id) && (
                <option value={draft.attachment_id}>
                  Anexo anterior indisponível — selecione outro ou remova o
                  vínculo
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
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
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
          {busy
            ? 'Salvando…'
            : reviewing
              ? 'Confirmar e salvar resultado'
              : 'Salvar resultado'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

export default ExamResultForm;
