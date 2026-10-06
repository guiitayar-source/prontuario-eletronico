import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';

export type Condition = {
  id: string;
  description: string;
  cid_code: string | null;
  status: 'hypothesis' | 'confirmed' | 'resolved';
  notes: string | null;
  icd11_code?: string | null;
  icd11_title?: string | null;
  icd11_release?: string | null;
  version: number;
};
export type ConsultationDiagnosis = {
  id: string;
  consultation_id: string;
  condition_id: string;
  description: string;
  cid_code: string | null;
  icd11_code: string | null;
  icd11_title: string | null;
  icd11_release: string | null;
  status: Condition['status'];
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
  consultationDiagnoses?: ConsultationDiagnosis[];
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
  icd11_code: '',
  icd11_title: '',
  icd11_release: '',
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
    [consultationDiagnoses, setConsultationDiagnoses] = useState<
      ConsultationDiagnosis[]
    >([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  async function load() {
    const d = await fetchClinicalContext(patientId);
    setConditions(d.conditions);
    setMedications(d.medications);
    setAllergies(d.allergies);
    setAllergyState(d.allergyState);
    setConsultationDiagnoses(d.consultationDiagnoses || []);
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
          setConsultationDiagnoses(d.consultationDiagnoses || []);
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
    consultationDiagnoses,
    error,
    busy,
    load,
    save,
    link: (consultationId: string, conditionId: string, linked: boolean) =>
      save({
        entity: 'consultation_diagnosis',
        patient_id: patientId,
        consultation_id: consultationId,
        condition_id: conditionId,
        linked,
      }),
    emptyCondition: () => emptyCondition(patientId),
    emptyMedication: () => emptyMedication(patientId),
    emptyAllergy: () => emptyAllergy(patientId),
  };
}
export type ClinicalContextController = ReturnType<typeof useClinicalContext>;
export const conditionLabel = {
  hypothesis: 'Hipótese',
  confirmed: 'Confirmado',
  resolved: 'Resolvido',
};
