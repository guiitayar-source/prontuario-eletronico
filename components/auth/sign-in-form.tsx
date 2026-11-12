'use client';
// Entrar com e-mail e senha, ou pedir por e-mail o link para definir a senha.

export type SignInFormProps = {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  error: string;
  message: string;
  busy: boolean;
  onSignIn: (event: React.SubmitEvent) => Promise<void>;
  /** Envia o link para definir a senha ao e-mail digitado. */
  onForgotPassword: () => Promise<void>;
};

export function SignInForm({
  email,
  setEmail,
  password,
  setPassword,
  error,
  message,
  busy,
  onSignIn,
  onForgotPassword,
}: SignInFormProps) {
  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSignIn}>
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
          onClick={onForgotPassword}
        >
          Esqueci minha senha
        </button>
      </form>
    </main>
  );
}
