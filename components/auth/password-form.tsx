'use client';
// Definir senha: primeiro acesso (convite) ou recuperação. Confere enquanto a pessoa digita o
// mínimo de 12 caracteres e se as duas senhas coincidem.
import { Check, AlertCircle, Mail } from 'lucide-react';

export type PasswordFormProps = {
  /** Primeiro acesso (convite); senão, recuperação de senha. */
  firstAccess: boolean;
  accountEmail: string;
  password: string;
  setPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  error: string;
  message: string;
  busy: boolean;
  onSave: (event: React.SubmitEvent) => Promise<void>;
  onSignOut: () => Promise<void>;
};

export function PasswordForm({
  firstAccess,
  accountEmail,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  error,
  message,
  busy,
  onSave,
  onSignOut,
}: PasswordFormProps) {
  const hasMinLength = password.length >= 12;
  const hasMatch = confirmPassword.length > 0 && password === confirmPassword;
  const hasMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSave}>
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
            void onSignOut();
          }}
        >
          Sair ou entrar com outra conta
        </button>
      </form>
    </main>
  );
}
