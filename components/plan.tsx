'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import type { Feature } from '@/lib/plan-features';

const Plan = createContext<readonly string[]>([]);

/** A função faz parte do plano da clínica? Fora do plano, a tela nem mostra o botão. */
export const useFeature = (feature: Feature) =>
  useContext(Plan).includes(feature);

/**
 * Lê o plano antes de abrir o prontuário, para que as telas já montem sabendo o que
 * esconder (sem botões que aparecem e somem). Se a leitura falhar, nada é liberado.
 */
export function PlanGate({
  clinic,
  children,
}: {
  clinic: string;
  children: React.ReactNode;
}) {
  const [features, setFeatures] = useState<string[] | null>(null);
  useEffect(() => {
    let active = true;
    setFeatures(null);
    getSupabaseBrowserClient()
      .from('clinic_features')
      .select('features')
      .eq('clinic_id', clinic)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setFeatures((data?.features as string[] | undefined) ?? []);
      });
    return () => {
      active = false;
    };
  }, [clinic]);
  if (!features) return null;
  return <Plan.Provider value={features}>{children}</Plan.Provider>;
}
