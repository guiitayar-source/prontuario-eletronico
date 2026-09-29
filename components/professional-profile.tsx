'use client';
import { useEffect, useState } from 'react';
import { IdCard } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import type { DocumentProfile } from '@/lib/document-fields';

const empty: DocumentProfile = {
  physician_name: '',
  physician_registration: '',
  letterhead_title: '',
  letterhead_address: '',
  letterhead_phone: '',
  cpf: null,
};
const fields: [keyof DocumentProfile, string, number, string][] = [
  ['physician_name', 'Nome profissional', 180, 'Dra. Ana Souza'],
  [
    'physician_registration',
    'Especialidade, CRM/UF e RQE',
    120,
    'Psiquiatra · CRM 000000/SP · RQE 00000',
  ],
  ['letterhead_title', 'Título do timbre', 120, 'CONSULTÓRIO DE PSIQUIATRIA'],
  ['letterhead_address', 'Endereço do consultório', 200, 'Rua, nº · Bairro · Sala'],
  ['letterhead_phone', 'Telefone', 80, 'Tel.: (00) 0000-0000'],
];

// Dados fixos de cada profissional: preenchem documentos e o timbre das receitas.
export function ProfessionalProfileCard() {
  const [profile, setProfile] = useState<DocumentProfile>(empty),
    [saved, setSaved] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void apiFetch('/api/documents?action=profile')
      .then(async (r) => {
        const d = (await r.json()) as {
          profile: DocumentProfile | null;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error);
        if (!active) return;
        const next = { ...empty, ...d.profile };
        setProfile(next);
        setSaved(JSON.stringify(next));
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const dirty = JSON.stringify(profile) !== saved;
  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await apiFetch('/api/documents?action=profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-Action': '1',
        },
        body: JSON.stringify(profile),
      });
      const d = (await r.json()) as { profile: DocumentProfile; error?: string };
      if (!r.ok) throw new Error(d.error);
      const next = { ...empty, ...d.profile, cpf: profile.cpf };
      setProfile(next);
      setSaved(JSON.stringify(next));
      setMessage('Dados profissionais salvos.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-header-icon">
          <IdCard size={20} />
        </div>
        <div>
          <h2>Meus dados profissionais</h2>
          <p>
            Usados nos seus novos documentos e no timbre das suas receitas. Cada
            profissional da equipe tem os próprios dados.
          </p>
        </div>
      </div>
      {loading ? (
        <p className="muted">Carregando…</p>
      ) : (
        <form
          className="professional-profile"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            {fields.map(([key, label, max, placeholder]) => (
              <label key={key}>
                {label}
                <input
                  maxLength={max}
                  placeholder={placeholder}
                  value={(profile[key] as string) || ''}
                  onChange={(e) =>
                    setProfile({ ...profile, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label>
              CPF do certificado digital
              <input
                value={profile.cpf || 'Definido ao conectar o Bird ID'}
                readOnly
              />
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
          {message && !dirty && (
            <output className="capture-notice">{message}</output>
          )}
          <button className="primary" type="submit" disabled={busy || !dirty}>
            {busy ? 'Salvando…' : 'Salvar dados'}
          </button>
        </form>
      )}
    </section>
  );
}
