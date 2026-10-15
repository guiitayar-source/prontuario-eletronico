import type { Feature } from '../plan-features.ts';
import { HttpError, type Context } from './server.ts';

const names: Record<Feature, string> = {
  ia: 'As funções de IA',
  anamnesator: 'O Anamnesator',
};

/** Recusa a chamada quando a função não faz parte do plano da clínica. */
export async function assertFeature(
  { db, clinic }: Pick<Context, 'db' | 'clinic'>,
  feature: Feature,
) {
  const { data, error } = await db
    .from('clinic_features')
    .select('features')
    .eq('clinic_id', clinic)
    .maybeSingle();
  if (error)
    throw new HttpError(503, 'Não foi possível verificar o plano da clínica.');
  if (!(data?.features as string[] | undefined)?.includes(feature))
    throw new HttpError(
      403,
      `${names[feature]} não faz parte do plano desta clínica.`,
    );
}
