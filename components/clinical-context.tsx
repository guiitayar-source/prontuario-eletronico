'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';

export type Condition = {
  id: string;
  description: string;
  cid_code: string | null;
  status: 'hypothesis' | 'confirmed' | 'resolved';
  notes: string | null;
  version: number;
};
export type Medication = {
  id: string;
  name: string;
  dose: string | null;
  instructions: string | null;
  status: 'active' | 'stopped';
  version: number;
};
export type Allergy = {
  id: string;
  substance: string;
  reaction: string | null;
  status: 'active' | 'inactive';
  version: number;
};
type AllergyState = { state: 'unknown' | 'none' | 'known'; version: number };
type ClinicalContextResponse = {
  error?: string;
  conditions: Condition[];
  medications: Medication[];
  allergies: Allergy[];
  allergyState: AllergyState;
};
async function fetchClinicalContext(patientId: string) {
  const response = await apiFetch(
    '/api/clinical-context?patientId=' + encodeURIComponent(patientId),
  );
  const data = (await response.json()) as ClinicalContextResponse;
  if (!response.ok)
    throw new Error(
      data.error || 'Não foi possível carregar o contexto clínico.',
    );
  return data;
}
const emptyCondition = (
  patient_id: string,
): Condition & { patient_id: string; entity: 'condition' } => ({
  entity: 'condition',
  id: crypto.randomUUID(),
  patient_id,
  description: '',
  cid_code: '',
  status: 'hypothesis',
  notes: '',
  version: 0,
});
const emptyMedication = (
  patient_id: string,
): Medication & { patient_id: string; entity: 'medication' } => ({
  entity: 'medication',
  id: crypto.randomUUID(),
  patient_id,
  name: '',
  dose: '',
  instructions: '',
  status: 'active',
  version: 0,
});
const emptyAllergy = (
  patient_id: string,
): Allergy & { patient_id: string; entity: 'allergy' } => ({
  entity: 'allergy',
  id: crypto.randomUUID(),
  patient_id,
  substance: '',
  reaction: '',
  status: 'active',
  version: 0,
});
export function useClinicalContext(patientId: string, enabled = true) {
  const [conditions, setConditions] = useState<Condition[]>([]),
    [medications, setMedications] = useState<Medication[]>([]),
    [allergies, setAllergies] = useState<Allergy[]>([]),
    [allergyState, setAllergyState] = useState<AllergyState>({
      state: 'unknown',
      version: 0,
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  async function load() {
    const d = await fetchClinicalContext(patientId);
    setConditions(d.conditions);
    setMedications(d.medications);
    setAllergies(d.allergies);
    setAllergyState(d.allergyState);
    setError('');
  }
  useEffect(() => {
    let active = true;
    if (enabled)
      void fetchClinicalContext(patientId)
        .then((d) => {
          if (!active) return;
          setConditions(d.conditions);
          setMedications(d.medications);
          setAllergies(d.allergies);
          setAllergyState(d.allergyState);
          setError('');
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [patientId, enabled, revision]);
  async function save(record: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(
        '/api/clinical-context?patientId=' + encodeURIComponent(patientId),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Clinical-Context-Action': '1',
          },
          body: JSON.stringify(record),
        },
      );
      const d = (await r.json()) as { error?: string };
      if (!r.ok)
        throw new Error(
          d.error || 'Não foi possível salvar o contexto clínico.',
        );
      setRevision((v) => v + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    patientId,
    conditions,
    medications,
    allergies,
    allergyState,
    error,
    busy,
    load,
    save,
    emptyCondition: () => emptyCondition(patientId),
    emptyMedication: () => emptyMedication(patientId),
    emptyAllergy: () => emptyAllergy(patientId),
  };
}
export type ClinicalContextController = ReturnType<typeof useClinicalContext>;
const conditionLabel = {
  hypothesis: 'Hipótese',
  confirmed: 'Confirmado',
  resolved: 'Resolvido',
};
export function ClinicalContextSummary({
  context,
  onEdit,
}: {
  context: ClinicalContextController;
  onEdit: () => void;
}) {
  const activeM = context.medications.filter((x) => x.status === 'active'),
    activeA = context.allergies.filter((x) => x.status === 'active'),
    activeC = context.conditions.filter((x) => x.status !== 'resolved');
  return (
    <>
      <div className="section-label context-heading">
        <span>CONTEXTO DO ATENDIMENTO</span>
        <button className="text-button" onClick={onEdit}>
          Editar contexto
        </button>
      </div>
      <section className="mini-section">
        <div className="card-heading">
          <span>Diagnósticos e hipóteses</span>
        </div>
        {activeC.length ? (
          activeC.map((x) => (
            <p key={x.id}>
              <strong>
                {x.cid_code && `${x.cid_code} · `}
                {x.description}
              </strong>
              <br />
              <small>{conditionLabel[x.status]}</small>
            </p>
          ))
        ) : (
          <p className="muted">Nenhum diagnóstico cadastrado.</p>
        )}
      </section>
      <section className="mini-section">
        <div className="card-heading">
          <span>Medicamentos atuais</span>
        </div>
        {activeM.length ? (
          activeM.map((x) => (
            <p key={x.id}>
              <strong>{x.name}</strong>
              {x.dose && <> · {x.dose}</>}
              {x.instructions && (
                <>
                  <br />
                  <small>{x.instructions}</small>
                </>
              )}
            </p>
          ))
        ) : (
          <p className="muted">Nenhum medicamento em uso.</p>
        )}
      </section>
      <section className="mini-section">
        <div className="card-heading">
          <span>Alergias</span>
        </div>
        {context.allergyState.state === 'none' ? (
          <p>Nega alergias conhecidas.</p>
        ) : context.allergyState.state === 'unknown' ? (
          <p className="muted">Não informadas</p>
        ) : activeA.length ? (
          activeA.map((x) => (
            <p key={x.id}>
              <strong>{x.substance}</strong>
              {x.reaction && (
                <>
                  <br />
                  <small>{x.reaction}</small>
                </>
              )}
            </p>
          ))
        ) : (
          <p className="muted">Alergias indicadas, sem item ativo.</p>
        )}
      </section>
      {context.error && (
        <p className="capture-error" role="alert">
          {context.error}
        </p>
      )}
    </>
  );
}
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
              <label>
                <span>CID opcional</span>
                <input
                  maxLength={20}
                  placeholder="Ex.: F31.8"
                  value={condition.cid_code || ''}
                  onChange={(e) =>
                    setCondition({ ...condition, cid_code: e.target.value })
                  }
                />
              </label>
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
