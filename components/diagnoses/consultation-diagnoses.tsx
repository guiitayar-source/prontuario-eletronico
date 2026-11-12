'use client';
// Diagnósticos do atendimento, logo abaixo da evolução: os já incluídos (com situação e CID-11),
// os que o paciente já tinha e o campo para um novo. A lógica está em use-consultation-diagnoses.ts.
import { Plus, Stethoscope, X } from 'lucide-react';
import type { Condition, ConsultationDiagnosis } from '../clinical-context';
import { CidAutocomplete } from './cid-autocomplete';
import { Icd11Suggestions, Icd11Tag } from './icd11-suggestions';
import {
  useConsultationDiagnoses,
  type ConsultationDiagnosesProps,
} from './use-consultation-diagnoses';

const statusLabel: Record<Condition['status'], string> = {
  hypothesis: 'Hipótese',
  confirmed: 'Confirmado',
  resolved: 'Resolvido',
};

/** Diagnósticos considerados no atendimento, exibidos logo abaixo da evolução. */
export function ConsultationDiagnoses({
  context,
  consultationId,
  locked,
  onEvolutionBlock,
}: ConsultationDiagnosesProps) {
  const {
    draft,
    setDraft,
    expanded,
    setExpanded,
    links,
    byId,
    previous,
    disabled,
    add,
    changeStatus,
    unlink,
    chooseIcd11,
    include,
    startDraft,
    startFreeDraft,
  } = useConsultationDiagnoses({
    context,
    consultationId,
    locked,
    onEvolutionBlock,
  });

  return (
    <section className="consultation-diagnoses" aria-labelledby="diagnoses-title">
      <div className="diagnoses-header">
        <h3 id="diagnoses-title">
          <Stethoscope size={16} aria-hidden /> Diagnósticos do atendimento
        </h3>
        {!locked && (
          <small>
            Escritos no fim da evolução e assinados junto com ela
          </small>
        )}
      </div>

      {links.length ? (
        <ul className="diagnoses-list">
          {links.map((link: ConsultationDiagnosis) => {
            const condition = byId.get(link.condition_id);
            const item = locked || !condition ? link : condition;
            return (
              <li key={link.id}>
                <div className="diagnosis-row">
                  <div className="diagnosis-main">
                    <strong>
                      {item.cid_code && <code>{item.cid_code}</code>}
                      {item.description}
                    </strong>
                    {item.icd11_code && (
                      <Icd11Tag code={item.icd11_code} title={item.icd11_title} />
                    )}
                  </div>
                  {locked || !condition ? (
                    <span className="context-item-badge">
                      {statusLabel[link.status]}
                    </span>
                  ) : (
                    <div className="diagnosis-actions">
                      <select
                        aria-label="Situação do diagnóstico"
                        value={condition.status}
                        disabled={disabled}
                        onChange={(e) =>
                          changeStatus(
                            condition,
                            e.target.value as Condition['status'],
                          )
                        }
                      >
                        <option value="hypothesis">Hipótese</option>
                        <option value="confirmed">Confirmado</option>
                        <option value="resolved">Resolvido</option>
                      </select>
                      {condition.cid_code && (
                        <button
                          type="button"
                          className="text-button"
                          aria-expanded={expanded === condition.id}
                          onClick={() =>
                            setExpanded(
                              expanded === condition.id ? null : condition.id,
                            )
                          }
                        >
                          {condition.icd11_code ? 'Alterar CID-11' : 'Ver CID-11'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remover ${condition.description} deste atendimento`}
                        title="Remover deste atendimento (continua no histórico do paciente)"
                        disabled={disabled}
                        onClick={() => unlink(condition)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                </div>
                {!locked && condition?.cid_code && expanded === condition.id && (
                  <Icd11Suggestions
                    cid10={condition.cid_code}
                    selected={condition.icd11_code}
                    disabled={disabled}
                    onSelect={(choice) => chooseIcd11(condition, choice)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">
          {locked
            ? 'Nenhum diagnóstico registrado neste atendimento.'
            : 'Nenhum diagnóstico registrado neste atendimento ainda.'}
        </p>
      )}

      {!locked && previous.length > 0 && (
        <div className="diagnoses-previous">
          <small>Diagnósticos do paciente:</small>
          {previous.map((c) => (
            <button
              type="button"
              key={c.id}
              className="diagnosis-chip"
              disabled={disabled}
              title="Incluir neste atendimento"
              onClick={() => include(c)}
            >
              <Plus size={13} aria-hidden />
              {c.cid_code && <code>{c.cid_code}</code>}
              {c.description}
            </button>
          ))}
        </div>
      )}

      {!locked &&
        (draft ? (
          <div className="diagnosis-draft">
            <div className="diagnosis-draft-row">
              <label>
                <span>Descrição</span>
                <input
                  maxLength={500}
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </label>
              <label>
                <span>Situação</span>
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      status: e.target.value as Condition['status'],
                    })
                  }
                >
                  <option value="hypothesis">Hipótese</option>
                  <option value="confirmed">Confirmado</option>
                </select>
              </label>
            </div>
            {draft.cid_code ? (
              <Icd11Suggestions
                cid10={draft.cid_code}
                selected={draft.icd11?.code}
                onSelect={(icd11) => setDraft({ ...draft, icd11 })}
              />
            ) : null}
            <div className="diagnosis-draft-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDraft(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled || !draft.description.trim()}
                onClick={() => void add()}
              >
                Adicionar ao atendimento
                {draft.cid_code && ` · ${draft.cid_code}`}
                {draft.icd11 && ` + ${draft.icd11.code}`}
              </button>
            </div>
          </div>
        ) : (
          <CidAutocomplete
            disabled={disabled}
            placeholder="Adicionar diagnóstico: digite nome ou código CID-10 (ex.: ansiedade, F41)"
            onPick={startDraft}
            onFreeText={startFreeDraft}
          />
        ))}
      {context.error && (
        <p className="capture-error" role="alert">
          {context.error}
        </p>
      )}
    </section>
  );
}
