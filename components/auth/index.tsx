'use client';
// Porta de entrada do app. Mostra, nesta ordem: carregando a sessão; definir senha (primeiro
// acesso ou recuperação); entrar; conta sem clínica; e, com tudo certo, o app dentro da
// checagem de MFA e do plano. A lógica está em use-auth.ts.
import { MFAGate } from '../mfa';
import { PlanGate } from '../plan';
import { Access } from './access';
import { PasswordForm } from './password-form';
import { SignInForm } from './sign-in-form';
import { useAuth } from './use-auth';

export { useAccess } from './access';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const {
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
  } = useAuth();

  if (!ready)
    return (
      <main className="auth-shell">
        <p>Carregando sessão…</p>
      </main>
    );

  // Form: Primeiro acesso OU Recuperação de senha
  if (isSettingPassword) {
    const accountEmail = session?.user?.email || email;
    return (
      <PasswordForm
        firstAccess={firstAccess}
        accountEmail={accountEmail}
        password={password}
        setPassword={setPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
        error={error}
        message={message}
        busy={busy}
        onSave={handlePasswordSave}
        onSignOut={signOut}
      />
    );
  }

  // Form: Login padrão
  if (!session) {
    return (
      <SignInForm
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        error={error}
        message={message}
        busy={busy}
        onSignIn={signIn}
        onForgotPassword={reset}
      />
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
        <PlanGate clinic={access.clinic}>{children}</PlanGate>
      </MFAGate>
    </Access.Provider>
  );
}
