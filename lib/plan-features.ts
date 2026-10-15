// Funções que dependem do plano da clínica (tabela clinic_features, alterada só pelo titular
// com scripts/clinic-plan.mjs). A tela esconde o que falta e o servidor recusa.
export const FEATURES = ['ia', 'anamnesator'] as const;
export type Feature = (typeof FEATURES)[number];
