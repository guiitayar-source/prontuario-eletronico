'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { setClinicId } from '@/lib/supabase/http';
import { MFAGate } from './mfa';

const Access = createContext({ role: '', clinic: '' });
export const useAccess = () => useContext(Access);
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<{ role: string; clinic: string } | null>(null);
  const [members, setMembers] = useState<{ clinic_id: string; role: string; clinics: { name: string } | null }[]>([]);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
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
      const db = getSupabaseBrowserClient();
      const activation = new URL(location.href).searchParams.get('activation');
      if (activation) {
        history.replaceState(null, '', location.pathname);
        setRecovery(true);
        void db.auth.verifyOtp({ token_hash: activation, type: 'recovery' }).then(({error}) => {
          if (active && error) { setRecovery(false); setError('Link de ativação expirado ou já utilizado. Solicite outro acesso.'); }
        });
      }
      db.auth.getSession().then(({ data, error }) => {
        if (!active) return;
        if (error) setError('Não foi possível recuperar a sessão. Entre novamente.');
        setSession(data.session); setReady(true);
      });
      const { data } = db.auth.onAuthStateChange((event, value) => {
        if (!active) return;
        setSession(value); setReady(true);
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
        if (event === 'SIGNED_OUT') { setAccess(null); setClinicId(''); setMembers([]); }
      });
      return () => { active = false; data.subscription.unsubscribe(); };
    } catch { setError('Configure a conexão Supabase para iniciar o prontuário.'); setReady(true); }
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    setAccess(null);
    getSupabaseBrowserClient().from('clinic_members').select('clinic_id,role,clinics(name)').eq('user_id', session.user.id).then(({ data, error }) => {
      if (!active) return;
      if (error) { setError('Não foi possível carregar suas permissões. Recarregue a página.'); return; }
      const rows = (data || []) as unknown as typeof members;
      setMembers(rows);
      if (rows[0]) { setClinicId(rows[0].clinic_id); setAccess({ clinic: rows[0].clinic_id, role: rows[0].role }); }
    });
    return () => { active = false; };
  }, [session?.user.id]);
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const db = getSupabaseBrowserClient();
      const result = recovery ? await db.auth.updateUser({ password }) : await db.auth.signInWithPassword({ email, password });
      if (result.error) throw new Error(recovery ? 'Não foi possível definir a senha. Use ao menos 12 caracteres.' : 'E-mail ou senha incorretos, ou conta ainda não ativada.');
      setPassword(''); setRecovery(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function reset() {
    if (!email) { setError('Informe seu e-mail para recuperar o acesso.'); return; }
    setBusy(true); setError('');
    try {
      const { error } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
      if (error) throw error;
      setMessage('Se o e-mail estiver cadastrado, você receberá as instruções de acesso.');
    } catch { setError('Não foi possível enviar as instruções. Tente novamente.'); } finally { setBusy(false); }
  }
  async function signOut() {
    if (!window.confirm('Sair da conta? Conclua os envios e salve os cadastros antes de sair.')) return;
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) { setError('Não foi possível sair. Tente novamente.'); return; }
    sessionStorage.removeItem('capture-desktop'); sessionStorage.removeItem('capture-mobile');
    setAccess(null); setClinicId('');
  }
  if (!ready) return <main className="auth-shell"><p>Carregando sessão…</p></main>;
  if (!session || recovery) return <main className="auth-shell"><form className="auth-card" onSubmit={signIn}>
    <div className="eyebrow">PSYWRITE</div><h1>{recovery ? 'Definir senha' : 'Entrar no prontuário'}</h1>
    <p>Use sua conta individual do prontuário.</p>
    {!recovery && <label>E-mail<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>}
    <label>Senha<input type="password" required minLength={recovery ? 12 : 1} autoComplete={recovery ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p role="alert" className="capture-error">{error}</p>}{message && <p role="status">{message}</p>}
    <button className="primary" disabled={busy}>{busy ? 'Aguarde…' : recovery ? 'Salvar senha' : 'Entrar'}</button>
    {!recovery && <button className="secondary" type="button" disabled={busy} onClick={reset}>Esqueci minha senha</button>}
    <small>Ambiente de desenvolvimento — use somente dados fictícios.</small>
  </form></main>;
  if (!access) return <main className="auth-shell"><div className="auth-card"><h1>Acesso à clínica</h1>
    <p>Sua conta precisa ser vinculada à clínica pelo administrador.</p>
    {error && <p role="alert">{error}</p>}<button className="secondary" onClick={() => location.reload()}>Verificar acesso</button><button className="secondary" onClick={signOut}>Sair</button>
  </div></main>;
  const clinicName = members.find((m) => m.clinic_id === access.clinic)?.clinics?.name || '';
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
