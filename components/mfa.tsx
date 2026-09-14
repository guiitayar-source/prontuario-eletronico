'use client';
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { Modal } from './modal';
import { Audit } from './audit';
import type { Session } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { Building2, ShieldCheck, LogOut, X } from 'lucide-react';

export function MFAGate({
  session,
  clinic,
  role,
  clinicName,
  userEmail,
  onSignOut,
  children,
}: {
  session: Session;
  clinic: string;
  role: string;
  clinicName?: string;
  userEmail?: string;
  onSignOut?: () => void;
  children: React.ReactNode;
}) {
  const [allowed, setAllowed] = useState(false),
    [ready, setReady] = useState(false),
    [open, setOpen] = useState(false);
  const [required, setRequired] = useState(false),
    [factor, setFactor] = useState(''),
    [enrolling, setEnrolling] = useState(false);
  const [qr, setQr] = useState(''),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [factors, setFactors] = useState<
    { id: string; friendly_name?: string }[]
  >([]);
  const refresh = useCallback(async () => {
    const db = getSupabaseBrowserClient();
    const [policy, assurance, list] = await Promise.all([
      db.from('clinics').select('require_mfa').eq('id', clinic).single(),
      db.auth.mfa.getAuthenticatorAssuranceLevel(),
      db.auth.mfa.listFactors(),
    ]);
    if (policy.error || assurance.error || list.error)
      throw new Error(
        'Não foi possível verificar a segurança da sessão. Tente novamente.',
      );
    const verified = list.data.totp.filter((f) => f.status === 'verified');
    setRequired(policy.data.require_mfa);
    setFactors(verified);
    if (verified.length) setFactor(verified[0].id);
    setAllowed(
      assurance.data.currentLevel === 'aal2' ||
        (!policy.data.require_mfa &&
          list.data.all.every((f) => f.status !== 'verified')),
    );
    setReady(true);
  }, [clinic]);
  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch((e) => {
        setAllowed(false);
        setError(e.message);
        setReady(true);
      });
  }, [session.access_token, refresh]);
  async function enroll() {
    setBusy(true);
    setError('');
    try {
      const db = getSupabaseBrowserClient();
      // Remove only abandoned, unverified TOTP enrollments, never verified factors.
      const list = await db.auth.mfa.listFactors();
      if (list.error) throw list.error;
      for (const f of list.data.all.filter(
        (f) => f.factor_type === 'totp' && f.status === 'unverified',
      )) {
        const r = await db.auth.mfa.unenroll({ factorId: f.id });
        if (r.error) throw r.error;
      }
      const r = await db.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'PsyWrite autenticador',
        issuer: 'PsyWrite',
      });
      if (r.error) throw r.error;
      setFactor(r.data.id);
      setQr(await QRCode.toDataURL(r.data.totp.uri));
      setEnrolling(true);
      setCode('');
    } catch {
      setError(
        'Não foi possível iniciar o autenticador. Verifique se TOTP está habilitado no Supabase.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await getSupabaseBrowserClient().auth.mfa.challengeAndVerify({
        factorId: factor,
        code,
      });
      if (r.error) throw r.error;
      setQr('');
      setCode('');
      setEnrolling(false);
      await refresh();
    } catch {
      setError(
        'Código não confirmado. Confira o relógio do celular e tente um código novo.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function mandate() {
    setBusy(true);
    setError('');
    try {
      const r = await getSupabaseBrowserClient().rpc('enable_clinic_mfa', {
        c: clinic,
      });
      if (r.error)
        throw new Error(
          'Confirme seu autenticador nesta sessão antes de exigir MFA da equipe.',
        );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const security = (
    <section className="auth-card" aria-labelledby="mfa-title">
      <div className="mfa-card-top">
        <div>
          <h2 id="mfa-title">Segurança da conta</h2>
          <p>
            {required
              ? 'Autenticador obrigatório para todos os membros da clínica.'
              : 'Configure seu autenticador para proteger o acesso ao prontuário.'}
          </p>
        </div>
        {allowed && (
          <button
            type="button"
            className="audit-btn-icon"
            onClick={() => {
              if (!busy) setOpen(false);
            }}
            title="Fechar"
          >
            <X size={18} />
          </button>
        )}
      </div>
      {!ready ? (
        <p>Verificando sessão…</p>
      ) : (
        <>
          {!factor && !enrolling && (
            <button className="primary" disabled={busy} onClick={enroll}>
              Configurar autenticador
            </button>
          )}
          {qr && (
            <>
              <p>
                No aplicativo autenticador do seu celular, adicione uma conta
                lendo este QR code. Guarde uma cópia segura no seu gerenciador
                de senhas, se ele suportar TOTP.
              </p>
              <Image
                unoptimized
                width={220}
                height={220}
                src={qr}
                alt="QR code privado de configuração do autenticador"
              />
            </>
          )}
          {factor && (!allowed || enrolling) && (
            <form onSubmit={verify}>
              {factors.length > 1 && !enrolling && (
                <label>
                  Autenticador
                  <select
                    value={factor}
                    onChange={(e) => setFactor(e.target.value)}
                  >
                    {factors.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.friendly_name || 'Autenticador'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Código de 6 dígitos
                <input
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              <button className="primary" disabled={busy}>
                Confirmar código
              </button>
            </form>
          )}
          {allowed && factors.length > 0 && !enrolling && (
            <p>Autenticador confirmado nesta sessão.</p>
          )}
          {role === 'owner' && !required && (
            <>
              <p>
                Após confirmar seu autenticador, você pode tornar o segundo
                fator obrigatório para médicos e secretárias. Cada pessoa
                configurará seu próprio celular ao entrar.
              </p>
              <button
                className="secondary"
                disabled={busy || !factors.length}
                onClick={mandate}
              >
                Exigir MFA para toda a clínica
              </button>
            </>
          )}
          <p>
            Se perder o autenticador, a recuperação exige conferência de
            identidade pelo administrador do projeto Supabase. Não compartilhe o
            QR code nem os códigos de acesso.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {error && (
        <button
          className="secondary"
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          Verificar novamente
        </button>
      )}
      {allowed && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Fechar
        </button>
      )}
    </section>
  );
  if (!allowed) return <main className="auth-shell">{security}</main>;
  return (
    <>
      <header className="account-bar">
        <div className="account-bar-left">
          <div className="clinic-badge-group">
            <Building2 size={15} className="clinic-icon" />
            <span className="clinic-name">{clinicName || 'Clínica'}</span>
          </div>
          <span className="account-sep">•</span>
          <span className="user-email" title={userEmail || session.user.email}>
            {userEmail || session.user.email}
          </span>
        </div>

        <div className="account-bar-right">
          <button
            type="button"
            className="header-btn"
            onClick={() => setOpen(true)}
            title="Configurações de segurança e segundo fator (MFA)"
          >
            <ShieldCheck size={15} />
            <span>Segurança · MFA</span>
            {factors.length > 0 && (
              <span
                className="mfa-dot"
                title="Segundo fator ativo nesta conta"
              />
            )}
          </button>

          {['owner', 'doctor'].includes(role) && <Audit />}

          {onSignOut && (
            <>
              <div className="header-divider" />
              <button
                type="button"
                className="header-btn btn-signout"
                onClick={onSignOut}
                title="Sair da conta"
              >
                <LogOut size={15} />
                <span>Sair</span>
              </button>
            </>
          )}
        </div>
      </header>

      {children}

      {open && (
        <Modal
          label="Segurança da conta"
          className="mfa-modal-dialog"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          {security}
        </Modal>
      )}
    </>
  );
}
