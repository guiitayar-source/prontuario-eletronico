// Lógica da entrada: lê a sessão do Supabase; trata o que chega no endereço (pareamento do
// celular, erro, convite, recuperação, ativação, código de acesso); carrega o vínculo com a
// clínica; entra, define a senha, pede o link de senha e sai. A tela está em index.tsx.
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { setClinicId } from '@/lib/supabase/http';

/** Estado e ações da tela de entrada. */
export function useAuth() {
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

      void db.auth.getSession().then(({ data, error }) => {
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
    // Depende do usuário, não do objeto de sessão (renovado a cada troca de token).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, isSettingPassword]);

  async function handlePasswordSave(event: React.SubmitEvent) {
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

  async function signIn(event: React.SubmitEvent) {
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

  return {
    ready,
    session,
    busy,
    access,
    members,
    email,
    setEmail,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    error,
    message,
    firstAccess,
    isSettingPassword,
    handlePasswordSave,
    signIn,
    reset,
    signOut,
  };
}
