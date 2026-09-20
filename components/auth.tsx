'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { setClinicId } from '@/lib/supabase/http';
import { MFAGate } from './mfa';
import { Check, AlertCircle, Mail } from 'lucide-react';

const Access = createContext({ role: '', clinic: '' });
export const useAccess = () => useContext(Access);

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<{ role: string; clinic: string } | null>(null);
  const [members, setMembers] = useState<
    { clinic_id: string; role: string; clinics: { name: string } | null }[]
  >([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [firstAccess, setFirstAccess] = useState(false);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      // Preserve phone pairing when sign-in or an invitation precedes capture.
      const hash = window.location.hash.slice(1);
      if (/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(hash)) {
        const [id, token] = hash.split('.');
        sessionStorage.setItem('capture-mobile', JSON.stringify({ id, token, expires_at: 0 }));
        history.replaceState(null, '', window.location.pathname);
      }

      const url = new URL(window.location.href);
      const searchParams = url.searchParams;
      const hashParams = new URLSearchParams(hash);

      // Check for errors returned by Supabase redirect (e.g. expired or invalid invite)
      const errorDesc =
        hashParams.get('error_description') || searchParams.get('error_description');
      if (errorDesc) {
        const decoded = decodeURIComponent(errorDesc).replace(/\+/g, ' ');
        if (
          decoded.toLowerCase().includes('expired') ||
          decoded.toLowerCase().includes('invalid')
        ) {
          setError(
            'O link de convite ou recuperação expirou ou já foi utilizado. Solicite um novo acesso.',
          );
        } else {
          setError(decoded);
        }
        history.replaceState(null, '', window.location.pathname);
      }

      // Detect invite or first-access flow
      const isInvite =
        hash.includes('type=invite') ||
        searchParams.get('type') === 'invite' ||
        searchParams.get('first_access') === 'true';

      const isRecovery =
        hash.includes('type=recovery') || searchParams.get('type') === 'recovery';

      if (isInvite) {
        setFirstAccess(true);
      }
      if (isRecovery) {
        setRecovery(true);
      }

      const db = getSupabaseBrowserClient();

      // Legacy or direct activation token
      const activation = searchParams.get('activation');
      if (activation) {
        history.replaceState(null, '', window.location.pathname);
        setRecovery(true);
        void db.auth
          .verifyOtp({ token_hash: activation, type: 'recovery' })
          .then(({ error }) => {
            if (active && error) {
              setRecovery(false);
              setError(
                'Link de ativação expirado ou já utilizado. Solicite outro acesso.',
              );
            }
          });
      }

      // PKCE code exchange if present in query
      const code = searchParams.get('code');
      if (code) {
        history.replaceState(null, '', window.location.pathname);
        void db.auth.exchangeCodeForSession(code).then(({ error }) => {
          if (active && error) {
            setError('Código de acesso inválido ou expirado.');
          }
        });
      }

      db.auth.getSession().then(({ data, error }) => {
        if (!active) return;
        if (error) setError('Não foi possível recuperar a sessão. Entre novamente.');
        setSession(data.session);
        if (data.session?.user?.user_metadata?.must_set_password === true) {
          setFirstAccess(true);
        }
        setReady(true);
      });

      const { data } = db.auth.onAuthStateChange((event, value) => {
        if (!active) return;
        setSession(value);
        setReady(true);
        if (event === 'PASSWORD_RECOVERY') {
          setRecovery(true);
        }
        if (value?.user?.user_metadata?.must_set_password === true) {
          setFirstAccess(true);
        }
        if (event === 'SIGNED_OUT') {
          setAccess(null);
          setClinicId('');
          setMembers([]);
          setFirstAccess(false);
          setRecovery(false);
        }
      });

      return () => {
        active = false;
        data.subscription.unsubscribe();
      };
    } catch {
      setError('Configure a conexão Supabase para iniciar o prontuário.');
      setReady(true);
    }
  }, []);

  const isSettingPassword =
    firstAccess ||
    recovery ||
    session?.user?.user_metadata?.must_set_password === true;

  useEffect(() => {
    if (!session || isSettingPassword) return;
    let active = true;
    setAccess(null);
    getSupabaseBrowserClient()
      .from('clinic_members')
      .select('clinic_id,role,clinics(name)')
      .eq('user_id', session.user.id)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setError('Não foi possível carregar suas permissões. Recarregue a página.');
          return;
        }
        const rows = (data || []) as unknown as typeof members;
        setMembers(rows);
        if (rows[0]) {
          setClinicId(rows[0].clinic_id);
          setAccess({ clinic: rows[0].clinic_id, role: rows[0].role });
        }
      });
    return () => {
      active = false;
    };
  }, [session?.user?.id, isSettingPassword]);

  async function handlePasswordSave(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 12) {
      setError('A senha deve ter no mínimo 12 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError(
        'As senhas digitadas não coincidem. Digite a mesma senha nos dois campos.',
      );
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const db = getSupabaseBrowserClient();
      const result = await db.auth.updateUser({
        password,
        data: {
          must_set_password: false,
          password_set: true,
        },
      });
      if (result.error) {
        throw new Error(
          result.error.message ||
            'Não foi possível salvar a senha. Tente novamente.',
        );
      }
      setPassword('');
      setConfirmPassword('');
      setFirstAccess(false);
      setRecovery(false);
      setMessage('Senha cadastrada com sucesso! Carregando prontuário...');
      const sess = await db.auth.getSession();
      setSession(sess.data.session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const db = getSupabaseBrowserClient();
      const result = await db.auth.signInWithPassword({ email, password });
      if (result.error) {
        throw new Error(
          'E-mail ou senha incorretos, ou convite ainda não aceito.',
        );
      }
      setPassword('');
      setConfirmPassword('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email) {
      setError('Informe seu e-mail para receber as instruções de acesso.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const siteOrigin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(
        email,
        {
          redirectTo: `${siteOrigin}/?first_access=true`,
        },
      );
      if (error) throw error;
      setMessage(
        'Se o e-mail estiver cadastrado, você receberá as instruções para definir a senha.',
      );
    } catch {
      setError('Não foi possível enviar as instruções. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (
      session &&
      !window.confirm(
        'Sair da conta? Conclua os envios e salve os cadastros antes de sair.',
      )
    )
      return;
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      setError('Não foi possível sair. Tente novamente.');
      return;
    }
    sessionStorage.removeItem('capture-desktop');
    sessionStorage.removeItem('capture-mobile');
    setAccess(null);
    setClinicId('');
    setFirstAccess(false);
    setRecovery(false);
    setPassword('');
    setConfirmPassword('');
    setError('');
    setMessage('');
  }

  if (!ready)
    return (
      <main className="auth-shell">
        <p>Carregando sessão…</p>
      </main>
    );

  // Form: Primeiro acesso OU Recuperação de senha
  if (isSettingPassword) {
    const accountEmail = session?.user?.email || email;
    const hasMinLength = password.length >= 12;
    const hasMatch = confirmPassword.length > 0 && password === confirmPassword;
    const hasMismatch = confirmPassword.length > 0 && password !== confirmPassword;

    return (
      <main className="auth-shell">
        <form className="auth-card" onSubmit={handlePasswordSave}>
          <div className="eyebrow">
            {firstAccess ? 'PRIMEIRO ACESSO · EQUIPE' : 'RECUPERAÇÃO DE ACESSO'}
          </div>
          <h1>
            {firstAccess ? 'Defina sua senha de acesso' : 'Definir nova senha'}
          </h1>
          <p>
            {firstAccess
              ? 'Seja bem-vindo(a) à clínica! Cadastre sua senha individual para acessar o prontuário.'
              : 'Cadastre sua nova senha de acesso individual.'}
          </p>

          {accountEmail && (
            <div className="auth-account-badge">
              <Mail size={16} />
              <span>
                Conta: <strong>{accountEmail}</strong>
              </span>
            </div>
          )}

          <label>
            Nova senha
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="Mínimo de 12 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          <label>
            Repetir nova senha
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="Digite a mesma senha novamente"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          <div className="auth-checklist">
            <div className={`auth-checklist-item ${hasMinLength ? 'valid' : ''}`}>
              <Check size={14} />
              <span>Mínimo de 12 caracteres ({password.length}/12)</span>
            </div>
            <div
              className={`auth-checklist-item ${hasMatch ? 'valid' : hasMismatch ? 'invalid' : ''}`}
            >
              {hasMismatch ? <AlertCircle size={14} /> : <Check size={14} />}
              <span>
                {hasMismatch ? 'As senhas não coincidem' : 'Senhas coincidem'}
              </span>
            </div>
          </div>

          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="capture-message">
              {message}
            </p>
          )}

          <button
            className="primary"
            disabled={busy || !hasMinLength || !hasMatch}
          >
            {busy ? 'Salvando senha…' : 'Salvar senha e entrar'}
          </button>

          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              void signOut();
            }}
          >
            Sair ou entrar com outra conta
          </button>
          <small>Ambiente de desenvolvimento — use somente dados fictícios.</small>
        </form>
      </main>
    );
  }

  // Form: Login padrão
  if (!session) {
    return (
      <main className="auth-shell">
        <form className="auth-card" onSubmit={signIn}>
          <div className="eyebrow">PSYWRITE</div>
          <h1>Entrar no prontuário</h1>
          <p>Use sua conta individual do prontuário.</p>
          <label>
            E-mail
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              required
              minLength={1}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="capture-message">
              {message}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Aguarde…' : 'Entrar'}
          </button>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={reset}
          >
            Esqueci minha senha
          </button>
          <small>Ambiente de desenvolvimento — use somente dados fictícios.</small>
        </form>
      </main>
    );
  }

  if (!access) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Acesso à clínica</h1>
          <p>Sua conta precisa ser vinculada à clínica pelo administrador.</p>
          {error && <p role="alert">{error}</p>}
          <button className="secondary" onClick={() => location.reload()}>
            Verificar acesso
          </button>
          <button className="secondary" onClick={signOut}>
            Sair
          </button>
        </div>
      </main>
    );
  }

  const clinicName =
    members.find((m) => m.clinic_id === access.clinic)?.clinics?.name || '';
  return (
    <Access.Provider value={access}>
      {error && <p className="capture-error" role="alert">{error}</p>}
      <MFAGate
        key={`${session.user.id}:${access.clinic}`}
        session={session}
        clinic={access.clinic}
        role={access.role}
        clinicName={clinicName}
        userEmail={session.user.email}
        onSignOut={signOut}
      >
        {children}
      </MFAGate>
    </Access.Provider>
  );
}
