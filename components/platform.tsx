'use client';
import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { FEATURES, FEATURE_LABELS, type Feature } from '@/lib/plan-features';

type ClinicRow = {
  id: string;
  name: string;
  createdAt: string | null;
  owner: string;
  ownerLastSignIn: string | null;
  doctors: number;
  secretaries: number;
  features: Feature[];
};

const day = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('pt-BR') : null;
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Painel do titular da plataforma, em Ajustes. Só aparece para as contas em
 * PSYWRITE_ADMIN_USER_IDS; mostra as contas dos assinantes, nunca dados de pacientes.
 */
export function PlatformPanel() {
  const [allowed, setAllowed] = useState(false);
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [email, setEmail] = useState('');
  const [clinicName, setClinicName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const r = await apiFetch('/api/platform');
    const d = (await r.json()) as { clinics?: ClinicRow[]; error?: string };
    if (!r.ok) throw new Error(d.error);
    setClinics(d.clinics || []);
  }

  useEffect(() => {
    let active = true;
    apiFetch('/api/platform?action=me')
      .then((r) => (r.ok ? r.json() : { admin: false }))
      .then((d: { admin?: boolean }) => {
        if (!active || !d.admin) return;
        setAllowed(true);
        void load().catch((e) => setError((e as Error).message));
      })
      .catch(() => {
        // Sem resposta: o painel simplesmente não aparece.
      });
    return () => {
      active = false;
    };
  }, []);

  async function send(action: string, data: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await apiFetch('/api/platform?action=' + action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Action': '1',
        },
        body: JSON.stringify(data),
      });
      const d = (await r.json()) as {
        invitationSent?: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error);
      await load();
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(clinic: ClinicRow, feature: Feature, on: boolean) {
    const features = FEATURES.filter((f) =>
      f === feature ? on : clinic.features.includes(f),
    );
    if (await send('features', { clinic_id: clinic.id, features }))
      setMessage(
        `Plano de ${clinic.name} atualizado. Vale quando a pessoa recarregar a página.`,
      );
  }

  if (!allowed) return null;
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-header-icon">
          <Building2 size={20} />
        </div>
        <div>
          <h2>Assinantes</h2>
          <p>
            Só você vê esta área. Mostra as contas e o plano de cada clínica,
            nunca os pacientes nem os prontuários.
          </p>
        </div>
      </div>

      <div className="team-page">
        <section className="team-section">
          <h2>Abrir clínica nova</h2>
          <p className="team-section-note">
            Cria a clínica e envia o convite ao médico, que vira o proprietário.
            A clínica começa sem IA e sem Anamnesator.
          </p>
          <form
            className="team-invite-form platform-new-clinic"
            onSubmit={(e) => {
              e.preventDefault();
              void send('provision', { email, clinic_name: clinicName }).then(
                (d) => {
                  if (!d) return;
                  setMessage(
                    d.invitationSent
                      ? `Clínica criada. Convite enviado para ${email}.`
                      : `Clínica criada e vinculada à conta que ${email} já tinha.`,
                  );
                  setEmail('');
                  setClinicName('');
                },
              );
            }}
          >
            <label className="team-field">
              <span>E-mail do médico</span>
              <input
                required
                type="email"
                value={email}
                disabled={busy}
                placeholder="dra.ana@consultorio.med.br"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="team-field">
              <span>Nome da clínica</span>
              <input
                required
                minLength={2}
                maxLength={120}
                value={clinicName}
                disabled={busy}
                placeholder="Consultório Dra. Ana"
                onChange={(e) => setClinicName(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={busy || !email || clinicName.trim().length < 2}
            >
              {busy ? 'Enviando…' : 'Criar e convidar'}
            </button>
          </form>
          {error && (
            <p className="capture-error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="capture-message" role="status">
              {message}
            </p>
          )}
        </section>

        <section className="team-section">
          <h2>
            Clínicas <span className="team-count">· {clinics.length}</span>
          </h2>
          <ul className="team-members">
            {clinics.map((clinic) => (
              <li key={clinic.id} className="team-member-row">
                <div className="team-member-info">
                  <strong>{clinic.name}</strong>
                  <small>
                    {clinic.owner}
                    {clinic.createdAt && ` · desde ${day(clinic.createdAt)}`}
                    {' · '}
                    {clinic.ownerLastSignIn
                      ? `último acesso ${day(clinic.ownerLastSignIn)}`
                      : 'ainda não entrou'}
                  </small>
                  <small>
                    {plural(clinic.doctors, 'médico', 'médicos')} ·{' '}
                    {plural(clinic.secretaries, 'secretária', 'secretárias')}
                  </small>
                </div>
                <div className="team-member-actions platform-features">
                  {FEATURES.map((feature) => (
                    <label key={feature}>
                      <input
                        type="checkbox"
                        checked={clinic.features.includes(feature)}
                        disabled={busy}
                        onChange={(e) =>
                          void toggle(clinic, feature, e.target.checked)
                        }
                      />
                      {FEATURE_LABELS[feature]}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
