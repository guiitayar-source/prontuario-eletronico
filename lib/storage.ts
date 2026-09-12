import { env } from 'cloudflare:workers';
export function storage() {
  const bindings = env as unknown as { DB: D1Database; FILES: R2Bucket };
  return { db: bindings.DB, bucket: bindings.FILES };
}
