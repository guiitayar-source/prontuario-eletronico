// Chamado somente após create + verify concluírem. Não lê nem envia conteúdo clínico.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateBackupReport } from './backup-report-validation.mjs';
const [file, seconds] = process.argv.slice(2);
try {
  const report = validateBackupReport(
    JSON.parse(await readFile(file, 'utf8')),
    Number(seconds),
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  for (let offset = 0; offset < report.clinics.length; offset += 500) {
    const inserted = await db
      .from('clinic_backup_events')
      .insert(
        report.clinics
          .slice(offset, offset + 500)
          .map((clinic) => ({
            id: randomUUID(),
            clinic_id: clinic,
            kind: 'verified',
            source: 'scheduled',
            backup_at: report.backup_at,
            occurred_at: report.occurred_at,
            verification_seconds: Number(seconds),
          })),
      );
    if (inserted.error) throw new Error();
  }
  console.log('Verificação comunicada ao painel de backups.');
} catch {
  console.error(
    'O backup foi verificado, mas não foi possível comunicar o resultado ao painel. Confira a migração e a configuração da rotina.',
  );
  process.exitCode = 1;
}
