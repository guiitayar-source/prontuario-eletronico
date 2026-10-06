'use client';
import { useState } from 'react';
import { CidAutocomplete, Icd11Suggestions } from '../diagnoses';
import {
  conditionLabel,
  type Allergy,
  type ClinicalContextController,
  type Condition,
  type Medication,
} from './use-clinical-context';

export function ClinicalContextEditor({
  context,
  onClose,
}: {
  context: ClinicalContextController;
  onClose: () => void;
}) {
  const [section, setSection] = useState<
    'conditions' | 'medications' | 'allergies'
  >('conditions');
  const [condition, setCondition] = useState(context.emptyCondition()),
    [medication, setMedication] = useState(context.emptyMedication()),
    [allergy, setAllergy] = useState(context.emptyAllergy());
  async function submit(record: Record<string, unknown>, reset: () => void) {
    if (await context.save(record)) reset();
  }
  return (
    <>
      <div className="context-modal-header">
        <h2 id="dialog-title">Contexto clínico</h2>
        <p>Informações longitudinais do paciente, visíveis nos retornos.</p>
      </div>
      <div className="patient-tabs context-tabs">
        <button
          className={section === 'conditions' ? 'selected' : ''}
          onClick={() => setSection('conditions')}
        >
          Diagnósticos
        </button>
        <button
          className={section === 'medications' ? 'selected' : ''}
          onClick={() => setSection('medications')}
        >
          Medicamentos
        </button>
        <button
          className={section === 'allergies' ? 'selected' : ''}
          onClick={() => setSection('allergies')}
        >
          Alergias
        </button>
      </div>
      {context.error && (
        <p className="capture-error" role="alert">
          {context.error}
        </p>
      )}
      {section === 'conditions' && (
        <>
          <div className="context-list">
            {context.conditions.map((x) => (
              <button
                key={x.id}
                className="consultation-history-link"
                onClick={() =>
                  setCondition({
                    ...x,
                    entity: 'condition',
                    patient_id: context.patientId,
                  })
                }
              >
                <strong>
                  {x.cid_code && `${x.cid_code} · `}
                  {x.description}
                  {x.icd11_code && ` · CID-11 ${x.icd11_code}`}
                </strong>
                <span className="context-item-badge">{conditionLabel[x.status]}</span>
              </button>
            ))}
          </div>
          <form
            className="context-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(condition, () =>
                setCondition(context.emptyCondition()),
              );
            }}
          >
            <h3>
              {condition.version
                ? 'Editar registro'
                : 'Adicionar diagnóstico ou hipótese'}
            </h3>
            <label>
              <span>Descrição</span>
              <input
                required
                maxLength={500}
                placeholder="Ex.: Transtorno afetivo bipolar, Hipertensão arterial..."
                value={condition.description}
                onChange={(e) =>
                  setCondition({ ...condition, description: e.target.value })
                }
              />
            </label>
            <div className="context-form-row">
              <div className="context-cid-field">
                <span>CID-10 opcional</span>
                {condition.cid_code ? (
                  <div className="context-cid-selected">
                    <code>{condition.cid_code}</code>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setCondition({
                          ...condition,
                          cid_code: '',
                          icd11_code: '',
                          icd11_title: '',
                          icd11_release: '',
                        })
                      }
                    >
                      Remover código
                    </button>
                  </div>
                ) : (
                  <CidAutocomplete
                    placeholder="Nome ou código (ex.: F31)"
                    onPick={(x) =>
                      setCondition({
                        ...condition,
                        cid_code: x.code,
                        description: condition.description.trim()
                          ? condition.description
                          : x.title,
                        icd11_code: '',
                        icd11_title: '',
                        icd11_release: '',
                      })
                    }
                  />
                )}
              </div>
              <label>
                <span>Situação</span>
                <select
                  value={condition.status}
                  onChange={(e) =>
                    setCondition({
                      ...condition,
                      status: e.target.value as Condition['status'],
                    })
                  }
                >
                  <option value="hypothesis">Hipótese</option>
                  <option value="confirmed">Confirmado</option>
                  <option value="resolved">Resolvido</option>
                </select>
              </label>
            </div>
            {condition.cid_code && (
              <Icd11Suggestions
                key={condition.id + condition.cid_code}
                cid10={condition.cid_code}
                selected={condition.icd11_code}
                onSelect={(choice) =>
                  setCondition({
                    ...condition,
                    icd11_code: choice?.code || '',
                    icd11_title: choice?.title || '',
                    icd11_release: choice?.release || '',
                  })
                }
              />
            )}
            <label>
              <span>Observações</span>
              <textarea
                placeholder="Observações clínicas ou anotações complementares..."
                maxLength={4000}
                value={condition.notes || ''}
                onChange={(e) =>
                  setCondition({ ...condition, notes: e.target.value })
                }
              />
            </label>
            <div className="editor-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setCondition(context.emptyCondition())}
              >
                Limpar
              </button>
              <button className="primary" disabled={context.busy}>
                {condition.version ? 'Atualizar registro' : 'Salvar registro'}
              </button>
            </div>
          </form>
        </>
      )}
      {section === 'medications' && (
        <>
          <div className="context-list">
            {context.medications.map((x) => (
              <button
                key={x.id}
                className="consultation-history-link"
                onClick={() =>
                  setMedication({
                    ...x,
                    entity: 'medication',
                    patient_id: context.patientId,
                  })
                }
              >
                <strong>
                  {x.name}
                  {x.dose && ` · ${x.dose}`}
                </strong>
                <span className="context-item-badge">{x.status === 'active' ? 'Em uso' : 'Suspenso'}</span>
              </button>
            ))}
          </div>
          <form
            className="context-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(medication, () =>
                setMedication(context.emptyMedication()),
              );
            }}
          >
            <h3>
              {medication.version
                ? 'Editar medicamento'
                : 'Adicionar medicamento'}
            </h3>
            <label>
              <span>Medicamento</span>
              <input
                required
                maxLength={300}
                placeholder="Ex.: Lítio, Sertralina, Losartana..."
                value={medication.name}
                onChange={(e) =>
                  setMedication({ ...medication, name: e.target.value })
                }
              />
            </label>
            <div className="context-form-row">
              <label>
                <span>Dose / Apresentação</span>
                <input
                  maxLength={200}
                  placeholder="Ex.: 300mg, 50mg/ml..."
                  value={medication.dose || ''}
                  onChange={(e) =>
                    setMedication({ ...medication, dose: e.target.value })
                  }
                />
              </label>
              <label>
                <span>Situação</span>
                <select
                  value={medication.status}
                  onChange={(e) =>
                    setMedication({
                      ...medication,
                      status: e.target.value as Medication['status'],
                    })
                  }
                >
                  <option value="active">Em uso</option>
                  <option value="stopped">Suspenso</option>
                </select>
              </label>
            </div>
            <label>
              <span>Modo de uso / Posologia</span>
              <textarea
                placeholder="Ex.: Tomar 1 comprimido à noite após o jantar..."
                maxLength={1000}
                value={medication.instructions || ''}
                onChange={(e) =>
                  setMedication({ ...medication, instructions: e.target.value })
                }
              />
            </label>
            <div className="editor-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setMedication(context.emptyMedication())}
              >
                Limpar
              </button>
              <button className="primary" disabled={context.busy}>
                {medication.version ? 'Atualizar medicamento' : 'Salvar medicamento'}
              </button>
            </div>
          </form>
        </>
      )}
      {section === 'allergies' && (
        <>
          <fieldset className="context-allergy-state" disabled={context.busy}>
            <legend>Estado geral</legend>
            {(
              [
                ['unknown', 'Não informado'],
                ['none', 'Nega alergias conhecidas'],
                ['known', 'Possui alergias'],
              ] as const
            ).map(([value, title]) => (
              <label key={value}>
                <input
                  type="radio"
                  checked={context.allergyState.state === value}
                  onChange={() =>
                    void context.save({
                      entity: 'allergy_state',
                      patient_id: context.patientId,
                      state: value,
                      version: context.allergyState.version,
                    })
                  }
                />
                {title}
              </label>
            ))}
          </fieldset>
          <div className="context-list">
            {context.allergies.map((x) => (
              <button
                key={x.id}
                className="consultation-history-link"
                onClick={() =>
                  setAllergy({
                    ...x,
                    entity: 'allergy',
                    patient_id: context.patientId,
                  })
                }
              >
                <strong>{x.substance}</strong>
                <span className="context-item-badge">
                  {x.status === 'active' ? 'Ativa' : 'Inativa'}
                  {x.reaction && ` · ${x.reaction}`}
                </span>
              </button>
            ))}
          </div>
          <form
            className="context-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(allergy, () => setAllergy(context.emptyAllergy()));
            }}
          >
            <h3>{allergy.version ? 'Editar alergia' : 'Adicionar alergia'}</h3>
            <div className="context-form-row">
              <label>
                <span>Substância</span>
                <input
                  required
                  maxLength={300}
                  placeholder="Ex.: Dipirona, Penicilina, Frutos do mar..."
                  value={allergy.substance}
                  onChange={(e) =>
                    setAllergy({ ...allergy, substance: e.target.value })
                  }
                />
              </label>
              <label>
                <span>Situação</span>
                <select
                  value={allergy.status}
                  onChange={(e) =>
                    setAllergy({
                      ...allergy,
                      status: e.target.value as Allergy['status'],
                    })
                  }
                >
                  <option value="active">Ativa</option>
                  <option value="inactive">Inativa</option>
                </select>
              </label>
            </div>
            <label>
              <span>Reação observada</span>
              <textarea
                placeholder="Ex.: Urticária, edema de glote, náuseas..."
                maxLength={1000}
                value={allergy.reaction || ''}
                onChange={(e) =>
                  setAllergy({ ...allergy, reaction: e.target.value })
                }
              />
            </label>
            <div className="editor-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setAllergy(context.emptyAllergy())}
              >
                Limpar
              </button>
              <button className="primary" disabled={context.busy}>
                {allergy.version ? 'Atualizar alergia' : 'Salvar alergia'}
              </button>
            </div>
          </form>
        </>
      )}
      <div className="context-modal-footer">
        <button className="secondary" disabled={context.busy} onClick={onClose}>
          Concluir
        </button>
      </div>
    </>
  );
}
