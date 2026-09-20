'use client';
import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarDays,
  ShieldCheck,
  Stethoscope,
  Users,
  UserPlus,
  UserX,
  Shield,
  Lock,
  Mail,
  Check,
  AlertCircle,
  CheckCircle2,
  Palette,
  Send,
} from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { useAccess } from './auth';
import { TopBar } from './topbar';
import type { Patient } from '@/lib/patient-fields';

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
  onOpenPatient,
}: {
  onPatients: () => void;
  onAgenda: () => void;
  onSettings?: () => void;
  onOpenPatient?: (p: Patient) => void;
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
      <aside className="rail">
        <div className="brand">
          <Activity size={23} />
        </div>
        <nav aria-label="Navegação principal">
          <button className="nav-item" onClick={onAgenda}>
            <CalendarDays size={21} />
            <span>Agenda</span>
          </button>
          <button className="nav-item" onClick={onPatients}>
            <Users size={21} />
            <span>Pacientes</span>
          </button>
          <button className="nav-item" disabled>
            <Stethoscope size={21} />
            <span>Consulta</span>
          </button>
          <button className="nav-item active">
            <ShieldCheck size={21} />
            <span>Equipe</span>
          </button>
          {onSettings && (
            <button className="nav-item" onClick={onSettings}>
              <Palette size={21} />
              <span>Ajustes</span>
            </button>
          )}
        </nav>
        <div className="rail-bottom">
          <span className="avatar doctor">G</span>
          <span>{label[role as keyof typeof label] || 'Equipe'}</span>
        </div>
      </aside>

      <div className="main-shell">
        <TopBar onSelectPatient={onOpenPatient} />

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
              <p>
                Gerencie os integrantes da clínica e controle os níveis de acesso médico e administrativo de acordo com o sigilo profissional.
              </p>
            </div>

            {role !== 'owner' ? (
              <div className="capture-error" role="alert">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <AlertCircle size={18} />
                  <span>Somente o proprietário da clínica pode gerenciar a equipe e permissões.</span>
                </div>
              </div>
            ) : (
              <div className="team-container">
                <section className="team-invite team-invite-card">
                  <div className="team-card-header">
                    <div className="team-header-icon">
                      <UserPlus size={20} />
                    </div>
                    <div>
                      <h2>Convidar novo integrante</h2>
                      <p>
                        Envie um convite para habilitar acesso individual à clínica ou vincular uma conta existente.
                      </p>
                    </div>
                  </div>

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
                    <div className="team-field-group">
                      <label htmlFor="team-email-input">E-mail</label>
                      <div className="team-input-wrapper">
                        <Mail size={16} className="input-icon" />
                        <input
                          id="team-email-input"
                          required
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="pessoa@consultorio.med.br"
                          disabled={busy}
                        />
                      </div>
                    </div>

                    <div className="team-field-group">
                      <label htmlFor="team-newrole-select">Nível de permissão</label>
                      <select
                        id="team-newrole-select"
                        value={newRole}
                        disabled={busy}
                        onChange={(e) =>
                          setNewRole(e.target.value as 'doctor' | 'secretary')
                        }
                      >
                        <option value="secretary">Secretária (Administrativo)</option>
                        <option value="doctor">Médico (Clínico)</option>
                      </select>
                    </div>

                    <button className="primary" disabled={busy || !email}>
                      <UserPlus size={16} />
                      {busy ? 'Enviando convite...' : 'Enviar convite'}
                    </button>
                  </form>
                </section>

                {error && (
                  <div className="capture-error" role="alert">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <AlertCircle size={18} />
                      <span>{error}</span>
                    </div>
                  </div>
                )}

                {message && (
                  <div className="capture-message" role="status">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <CheckCircle2 size={18} />
                      <span>{message}</span>
                    </div>
                  </div>
                )}

                <section className="team-list team-list-card">
                  <div className="team-list-header">
                    <h2>Integrantes da equipe</h2>
                    <span className="team-count-badge">
                      {members.length} {members.length === 1 ? 'integrante ativo' : 'integrantes ativos'}
                    </span>
                  </div>

                  <div className="team-members-list">
                    {members.map((member) => (
                      <article key={member.user_id} className="team-member team-member-item">
                        <div className="team-member-main">
                          <span className={`team-avatar ${member.role}`}>
                            {getInitials(member.email)}
                          </span>
                          <div className="team-member-details">
                            <div className="team-member-email-row">
                              <strong className="team-member-email">{member.email}</strong>
                              <span className={`role-badge ${member.role}`}>
                                {label[member.role]}
                              </span>
                              {member.pendingFirstAccess && (
                                <span
                                  className="role-badge"
                                  style={{
                                    background: '#fff8eb',
                                    color: '#9c5b05',
                                    border: '1px solid #fedf89',
                                    fontSize: '11px',
                                    padding: '2px 8px',
                                    fontWeight: 500,
                                  }}
                                  title="Este integrante foi convidado mas ainda não cadastrou a senha individual no primeiro acesso"
                                >
                                  Primeiro acesso pendente
                                </span>
                              )}
                            </div>
                            <span className="team-member-meta">
                              Incluído em{' '}
                              {new Date(member.created_at).toLocaleDateString('pt-BR')}
                            </span>
                          </div>
                        </div>

                        {member.role === 'owner' ? (
                          <div className="team-actions team-member-actions">
                            <span className="role-badge owner">
                              <Shield size={13} />
                              Proprietário
                            </span>
                          </div>
                        ) : (
                          <div className="team-actions team-member-actions">
                            <button
                              className="team-resend-button"
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
                              <Send size={14} />
                              Reenviar convite
                            </button>
                            <select
                              aria-label={'Papel de ' + member.email}
                              value={member.role}
                              disabled={busy}
                              className="team-role-select"
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
                              className="team-revoke-button"
                              disabled={busy}
                              type="button"
                              title="Revogar acesso à clínica"
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
                              <UserX size={15} />
                              Revogar acesso
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>

                <section className="team-roles-guide note-card-enhanced">
                  <div className="team-guide-header">
                    <div className="team-header-icon">
                      <ShieldCheck size={20} />
                    </div>
                    <div>
                      <h3>Controle de Acessos e Diretrizes de Privacidade</h3>
                      <p>
                        Estrutura configurada em conformidade com as diretrizes do CFM e a Lei Geral de Proteção de Dados (LGPD).
                      </p>
                    </div>
                  </div>

                  <div className="team-roles-grid">
                    <div className="team-role-card">
                      <div className="team-role-card-head">
                        <span className="team-role-title">
                          <Stethoscope size={18} className="team-feature-check" />
                          Médico
                        </span>
                        <span className="role-badge doctor">Acesso Clínico</span>
                      </div>
                      <ul className="team-role-features">
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Prontuário completo, histórico e evolução clínica
                        </li>
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Prescrições, atestados e pedidos de exames
                        </li>
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Agenda de atendimentos e lista de pacientes
                        </li>
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Visualização e anexação de laudos/exames
                        </li>
                      </ul>
                    </div>

                    <div className="team-role-card">
                      <div className="team-role-card-head">
                        <span className="team-role-title">
                          <Users size={18} style={{ color: '#2a5b73' }} />
                          Secretária
                        </span>
                        <span className="role-badge secretary">Acesso Administrativo</span>
                      </div>
                      <ul className="team-role-features">
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Gestão e marcação de consultas na agenda
                        </li>
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Cadastro e atualização cadastral de pacientes
                        </li>
                        <li>
                          <Check size={16} className="team-feature-check" />
                          Envio e organização de guias e documentos
                        </li>
                        <li style={{ color: '#824838', fontWeight: 500 }}>
                          <Lock size={16} className="team-feature-lock" />
                          Sigilo: sem acesso a prontuários e anotações clínicas
                        </li>
                      </ul>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
