// Somente engines e imagens locais explicitamente admitidas. Sem pull/rede.
import assert from 'node:assert/strict';
export const containerEngine = process.env.SNCR_TEST_CONTAINER_ENGINE || 'docker';
export const containerImage = process.env.SNCR_TEST_CONTAINER_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.167';
assert.ok(['docker', 'podman'].includes(containerEngine));
assert.ok([
  'public.ecr.aws/supabase/postgres:17.6.1.167',
  'public.ecr.aws/supabase/postgres:17.6.1.171',
].includes(containerImage));
