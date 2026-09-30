'use client';
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { useAccess } from './auth';
import { NavigationRail } from './navigation-rail';

type Member = {
  user_id: string;
  role: 'owner' | 'doctor' | 'secretary';
  email: string;
  created_at: string;
  pendingFirstAccess?: boolean;
};

const label = {
  owner: 'Proprietário',
  doctor: 'Médico',
  secretary: 'Secretária',
};

// Reflete as checagens de papel da API (lib/supabase/*) e das políticas RLS.
const permissions: [string, boolean, boolean][] = [
  ['Prontuário, evolução e contexto clínico', true, false],
  ['Receitas, atestados e documentos', true, false],
  ['Exames e leitura por IA', true, false],
  ['Agenda', true, true],
  ['Cadastro de pacientes', true, true],
  ['Envio de anexos', true, true],
];

function getInitials(email: string): string {
  const namePart = email.split('@')[0] || '';
  const clean = namePart.replace(/[^a-zA-Z0-9]/g, ' ').trim();
  const parts = clean.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export default function Team({
  onPatients,
  onAgenda,
  onSettings,
}: {
  onPatients: () => void;
  onAgenda: () => void;
  onSettings?: () => void;
}) {
  const { role } = useAccess();
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<'doctor' | 'secretary'>('secretary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const r = await apiFetch('/api/team');
    const d = (await r.json()) as { members?: Member[]; error?: string };
    if (!r.ok) throw new Error(d.error);
    setMembers(d.members || []);
  }

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);

  async function change(action: string, data: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await apiFetch('/api/team?action=' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Team-Action': '1' },
        body: JSON.stringify(data),
      });
      const d = (await r.json()) as {
        invitationSent?: boolean;
        error?: string;
        email?: string;
      };
      if (!r.ok) throw new Error(d.error);
      setMessage(
        action === 'invite'
          ? d.invitationSent
            ? 'Convite enviado por e-mail com sucesso.'
            : 'Acesso concedido. Esta conta já possuía cadastro ativo.'
          : action === 'resend_invite'
            ? `Convite reenviado por e-mail com sucesso para ${d.email || 'o integrante'}.`
            : action === 'revoke'
              ? 'Acesso revogado com sucesso.'
              : 'Papel do integrante atualizado com sucesso.',
      );
      setEmail('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <NavigationRail
        active="team"
        onAgenda={onAgenda}
        onPatients={onPatients}
        onSettings={onSettings}
      />

      <div className="main-shell">

        <main>
          <div className="breadcrumb">
            <button onClick={onPatients}>Consultório</button>
            <span>›</span>
            <span>Equipe e acessos</span>
          </div>

          <section className="listing">
            <div className="listing-heading">
              <div className="eyebrow">ADMINISTRAÇÃO</div>
              <h1>Equipe e acessos</h1>
              <p>Integrantes da clínica e o que cada papel pode acessar.</p>
            </div>

            {role !== 'owner' ? (
              <p className="capture-error" role="alert">
                Somente o proprietário da clínica pode gerenciar a equipe e as permissões.
              </p>
            ) : (
              <div className="team-page">
                <section className="team-section">
                  <h2>Convidar integrante</h2>
                  <p className="team-section-note">
                    O convite habilita um acesso individual à clínica ou vincula uma conta existente.
                  </p>
                  <form
                    className="team-invite-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void change('invite', {
                        email,
                        role: newRole,
                        origin:
                          typeof window !== 'undefined'
                            ? window.location.origin
                            : undefined,
                      });
                    }}
                  >
                    <label className="team-field">
                      <span>E-mail</span>
                      <input
                        required
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="pessoa@consultorio.med.br"
                        disabled={busy}
                      />
                    </label>
                    <label className="team-field">
                      <span>Papel</span>
                      <select
                        value={newRole}
                        disabled={busy}
                        onChange={(e) =>
                          setNewRole(e.target.value as 'doctor' | 'secretary')
                        }
                      >
                        <option value="secretary">Secretária</option>
                        <option value="doctor">Médico</option>
                      </select>
                    </label>
                    <button className="primary" disabled={busy || !email}>
                      {busy ? 'Enviando…' : 'Enviar convite'}
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
                    Integrantes <span className="team-count">· {members.length}</span>
                  </h2>
                  <ul className="team-members">
                    {members.map((member) => (
                      <li key={member.user_id} className="team-member-row">
                        <span className="team-avatar" aria-hidden>
                          {getInitials(member.email)}
                        </span>
                        <div className="team-member-info">
                          <strong>{member.email}</strong>
                          <small>
                            {label[member.role]}
                            {member.pendingFirstAccess && ' · primeiro acesso pendente'}
                            {' · desde '}
                            {new Date(member.created_at).toLocaleDateString('pt-BR')}
                          </small>
                        </div>
                        {member.role !== 'owner' && (
                          <div className="team-member-actions">
                            <select
                              aria-label={'Papel de ' + member.email}
                              value={member.role}
                              disabled={busy}
                              onChange={(e) =>
                                void change('role', {
                                  user_id: member.user_id,
                                  role: e.target.value,
                                })
                              }
                            >
                              <option value="secretary">Secretária</option>
                              <option value="doctor">Médico</option>
                            </select>
                            <button
                              className="text-button"
                              disabled={busy}
                              type="button"
                              title="Reenviar e-mail de convite para este integrante"
                              onClick={() => {
                                void change('resend_invite', {
                                  user_id: member.user_id,
                                  origin:
                                    typeof window !== 'undefined'
                                      ? window.location.origin
                                      : undefined,
                                });
                              }}
                            >
                              Reenviar convite
                            </button>
                            <button
                              className="text-button danger"
                              disabled={busy}
                              type="button"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Revogar o acesso de ${member.email} à clínica?`,
                                  )
                                )
                                  void change('revoke', {
                                    user_id: member.user_id,
                                  });
                              }}
                            >
                              Revogar
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="team-section">
                  <h2>Permissões por papel</h2>
                  <table className="team-permissions">
                    <thead>
                      <tr>
                        <th scope="col">Área</th>
                        <th scope="col">Médico</th>
                        <th scope="col">Secretária</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permissions.map(([area, doctor, secretary]) => (
                        <tr key={area}>
                          <th scope="row">{area}</th>
                          <td>{doctor ? <Check size={15} aria-label="Sim" /> : <span aria-label="Não">—</span>}</td>
                          <td>{secretary ? <Check size={15} aria-label="Sim" /> : <span aria-label="Não">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="team-section-note">
                    A secretária não acessa prontuários, documentos clínicos nem anotações, em linha com o sigilo profissional (CFM) e a LGPD. Somente o proprietário gerencia a equipe.
                  </p>
                </section>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
