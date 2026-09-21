'use client';
import { useAccess } from '../auth';
import { apiFetch as fetch } from '@/lib/supabase/http';
import { useEffect, useRef, useState } from 'react';
import {
  Search,
  Plus,
  UserRound,
  ChevronRight,
  Activity,
  Users,
  ArrowLeft,
  Check,
  CalendarDays,
  Stethoscope,
  ShieldCheck,
  Palette,
} from 'lucide-react';
import {
  fieldGroups,
  emptyPatient,
  initials,
  age,
  type Patient,
  type PatientInput,
} from '@/lib/patient-fields';
import { TopBar } from '@/components/topbar';
import { NavigationRail } from '../navigation-rail';
import { PatientSearch } from './search';
export { PatientSearch };
export async function fetchPatient(id: string) {
  const r = await fetch(`/api/patients?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  const d = (await r.json()) as { patient: Patient; error?: string };
  if (!r.ok) throw new Error(d.error || 'Não foi possível abrir o paciente.');
  return d.patient;
}
export function PatientForm({
  patient,
  onSaved,
  onCancel,
  onDirty,
}: {
  patient?: Patient;
  onSaved: (p: Patient) => void;
  onCancel: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [form, setForm] = useState<PatientInput>(patient || emptyPatient()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [conflict, setConflict] = useState(false),
    [discard, setDiscard] = useState(false);
  const id = useRef(patient?.id || crypto.randomUUID());
  const dirty =
    JSON.stringify(form) !== JSON.stringify(patient || emptyPatient());
  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrors({});
    try {
      const r = await fetch(
        `/api/patients?action=${patient ? 'update' : 'create'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Patient-Action': '1',
          },
          body: JSON.stringify({
            ...form,
            id: id.current,
            version: patient?.version,
          }),
        },
      );
      const d = (await r.json()) as {
        patient: Patient;
        error?: string;
        fields?: Record<string, string>;
        conflict?: boolean;
      };
      if (!r.ok) {
        setErrors(d.fields || {});
        setConflict(!!d.conflict);
        throw new Error(d.error || 'Falha ao salvar.');
      }
      onSaved(d.patient);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="registry-title">
        <div>
          <div className="eyebrow">DADOS CADASTRAIS</div>
          <h2>{patient ? 'Editar cadastro' : 'Novo paciente'}</h2>
          <p>
            Somente o nome é obrigatório. Complete os demais dados quando
            estiverem disponíveis.
          </p>
        </div>
      </div>
      <div className="capture-notice">
        Protótipo: cadastre somente pessoas e informações fictícias.
      </div>
      {error && (
        <div className="capture-error" role="alert">
          {error}
        </div>
      )}
      {conflict && (
        <p className="capture-error">
          Suas alterações permanecem nesta tela para consulta. Cancele e reabra
          o cadastro para carregar a versão atual.
        </p>
      )}
      {fieldGroups.map((group, i) => (
        <details
          className="form-group"
          key={group.title}
          open={i < 2 || group.fields.some(([f]) => errors[f]) || undefined}
        >
          <summary>{group.title}</summary>
          <div className="form-grid">
            {group.fields.map(([f, label, type]) => (
              <label
                className={type === 'textarea' ? 'wide-field' : ''}
                key={f}
                htmlFor={`patient-${f}`}
              >
                <span>
                  {label}
                  {f === 'name' ? ' *' : ''}
                </span>
                {type === 'textarea' ? (
                  <textarea
                    id={`patient-${f}`}
                    value={form[f]}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                ) : (
                  <input
                    id={`patient-${f}`}
                    type={type}
                    autoComplete="off"
                    value={form[f]}
                    required={f === 'name'}
                    maxLength={f === 'state' ? 2 : 180}
                    disabled={busy}
                    aria-invalid={!!errors[f]}
                    aria-describedby={errors[f] ? `error-${f}` : undefined}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                )}{' '}
                {errors[f] && (
                  <small id={`error-${f}`} className="field-error">
                    {errors[f]}
                  </small>
                )}
              </label>
            ))}
          </div>
        </details>
      ))}
      <footer className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => (dirty ? setDiscard(true) : onCancel())}
        >
          Cancelar
        </button>
        <button className="primary" disabled={busy || conflict}>
          <Check size={17} />
          {busy ? 'Salvando…' : 'Salvar cadastro'}
        </button>
      </footer>
      {discard && (
        <div className="discard-confirm" role="alert">
          <p>Descartar as alterações ainda não salvas?</p>
          <button
            type="button"
            className="secondary"
            onClick={() => setDiscard(false)}
          >
            Continuar editando
          </button>
          <button type="button" className="primary danger" onClick={onCancel}>
            Descartar alterações
          </button>
        </div>
      )}
    </form>
  );
}
export function PatientDetails({
  patient,
  onUpdated,
  onDirty,
}: {
  patient: Patient;
  onUpdated: (p: Patient) => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <PatientForm
        patient={patient}
        onDirty={onDirty}
        onCancel={() => setEdit(false)}
        onSaved={(p) => {
          onUpdated(p);
          setEdit(false);
        }}
      />
    );
  return (
    <section className="patient-details">
      <div className="registry-title">
        <div>
          <h2>Dados cadastrais</h2>
          <p>
            Atualizado em {new Date(patient.updated_at).toLocaleString('pt-BR')}
          </p>
        </div>
        <button className="primary" onClick={() => setEdit(true)}>
          Editar cadastro
        </button>
      </div>
      {fieldGroups.map((group) => (
        <section className="detail-group" key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.fields.map(([f, label]) => (
              <div key={f} className={f === 'admin_notes' ? 'wide-field' : ''}>
                <dt>{label}</dt>
                <dd>
                  {f === 'dob' && patient[f]
                    ? patient[f].split('-').reverse().join('/')
                    : patient[f] || 'Não informado'}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </section>
  );
}
export default function Registry({
  onOpen,
  onAgenda,
  onConsultation,
  onTeam,
  onImports,
  onSettings,
}: {
  onOpen: (p: Patient) => void;
  onAgenda: () => void;
  onConsultation: () => void;
  onTeam: () => void;
  onImports: () => void;
  onSettings?: () => void;
}) {
  const [create, setCreate] = useState(false);
  const medical = ['owner', 'doctor'].includes(useAccess().role);
  return (
    <div className="app-shell">
      <NavigationRail
        active="patients"
        onAgenda={onAgenda}
        onConsultation={onConsultation}
        onTeam={onTeam}
        onSettings={onSettings}
      />
      <div className="main-shell">
        <TopBar onSelectPatient={onOpen} />
        <main>
          {create ? (
            <PatientForm onCancel={() => setCreate(false)} onSaved={onOpen} />
          ) : (
            <>
              <div className="registry-title">
                <div>
                  <div className="eyebrow">CONSULTÓRIO</div>
                  <h1>Pacientes</h1>
                  <p>Encontre um paciente ou comece um novo cadastro.</p>
                </div>
                {medical && (
                  <button className="secondary" onClick={onImports}>
                    Importar prontuários
                  </button>
                )}
                <button className="primary" onClick={() => setCreate(true)}>
                  <Plus size={18} /> Novo paciente
                </button>
              </div>
              <PatientSearch onOpen={onOpen} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
