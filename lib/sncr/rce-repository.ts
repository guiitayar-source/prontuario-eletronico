import type { RceEmission, RceRepository } from './rce-workflow.ts';

export function rceRepository(options: {
  id: string;
  clinic: string;
  user: string;
  rpc: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
  get: () => Promise<RceEmission>;
}): RceRepository {
  const base = { eid: options.id, c: options.clinic, u: options.user };
  return {
    get: options.get,
    acquire: (hash, checked) =>
      options.rpc('sncr_rce_acquire', { ...base, h: hash, checked }),
    transition: (attempt, expected, next, meta) =>
      options.rpc('sncr_rce_transition', {
        ...base,
        a: attempt,
        expected,
        next_state: next,
        meta: meta || null,
      }),
    finish: (attempt, path, hash, signedAt, verification) =>
      options.rpc('sncr_rce_finish', {
        ...base,
        a: attempt,
        p: path,
        h: hash,
        t: signedAt,
        verification_data: verification,
      }),
  };
}
