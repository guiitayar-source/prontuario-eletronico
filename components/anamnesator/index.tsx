'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useAnamnesatorSession,
  type AnamnesatorSession,
  type SessionPatient,
} from './use-anamnesator-session';
import { AnamnesatorDock } from './panel';

export type ApplyMode = 'replace' | 'append';

/** Atendimento aberto na tela, onde o rascunho pode ser inserido. */
export type AnamnesatorTarget = {
  patient: SessionPatient;
  disabled: boolean;
  apply: (text: string, mode: ApplyMode) => void;
};

type Context = {
  session: AnamnesatorSession;
  show: () => void;
  register: (target: AnamnesatorTarget) => () => void;
};
const AnamnesatorContext = createContext<Context | null>(null);

/**
 * Mantém a sessão do Anamnesator acima das telas, para que a gravação e o texto
 * continuem ao navegar pelo prontuário, trocar de aba ou ir à agenda.
 */
export function AnamnesatorProvider({ children }: { children: ReactNode }) {
  const session = useAnamnesatorSession();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AnamnesatorTarget | null>(null);
  const register = useCallback((next: AnamnesatorTarget) => {
    setTarget(next);
    return () => setTarget((current) => (current === next ? null : current));
  }, []);
  const show = useCallback(() => setOpen(true), []);
  return (
    <AnamnesatorContext.Provider value={{ session, show, register }}>
      {children}
      <AnamnesatorDock
        session={session}
        target={target}
        open={open}
        onOpen={() => setOpen(true)}
        onMinimize={() => setOpen(false)}
      />
    </AnamnesatorContext.Provider>
  );
}

/** Abre o painel e lê o resumo da sessão (para o botão do atendimento). */
export function useAnamnesator() {
  const context = useContext(AnamnesatorContext);
  if (!context) throw new Error('AnamnesatorProvider ausente.');
  return {
    show: context.show,
    summary: context.session.summary,
    patientId: context.session.patient?.id,
  };
}

/** Registra o atendimento aberto como destino do rascunho enquanto estiver na tela. */
export function useAnamnesatorTarget(
  patient: SessionPatient,
  disabled: boolean,
  apply: AnamnesatorTarget['apply'],
) {
  const register = useContext(AnamnesatorContext)?.register;
  const latest = useRef(apply);
  useEffect(() => {
    latest.current = apply;
  });
  useEffect(() => {
    if (!register) return;
    return register({
      patient: { id: patient.id, name: patient.name },
      disabled,
      apply: (text, mode) => latest.current(text, mode),
    });
  }, [register, patient.id, patient.name, disabled]);
}
