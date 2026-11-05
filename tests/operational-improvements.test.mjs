import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditFilters } from '../lib/supabase/audit.ts';
import { backupWarnings } from '../lib/backup-status.ts';
import { validateBackupReport } from '../scripts/backup-report-validation.mjs';

test('filtros da auditoria validam datas e cursor sem aceitar fragmentos de consulta', () => {
  const f = auditFilters(
    new URLSearchParams({
      from: '2026-11-01',
      to: '2026-11-02',
      q: 'x),clinic_id.eq.other',
      before: '9007199254740993',
    }),
  );
  assert.equal(f.from_at, '2026-11-01T03:00:00.000Z');
  assert.equal(f.to_at, '2026-11-03T03:00:00.000Z');
  assert.equal(f.before_id, '9007199254740993');
  assert.equal(f.search, 'x),clinic_id.eq.other');
  for (const params of [
    { from: '2026-02-30' },
    { before: '-1' },
    { actor: 'abc' },
    { category: 'other' },
    { from: '2026-11-03', to: '2026-11-01' },
  ])
    assert.throws(() => auditFilters(new URLSearchParams(params)));
});
test('aviso de cópia externa considera idade dos dados, não só a declaração recente', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const verified = {
    backup_at: '2026-11-04T11:00:00Z',
    occurred_at: '2026-11-04T11:30:00Z',
  };
  const external = {
    backup_at: '2026-10-01T12:00:00Z',
    occurred_at: '2026-11-04T12:00:00Z',
  };
  assert.equal(
    backupWarnings({ available: true, verified, external }, now).length,
    1,
  );
  assert.equal(
    backupWarnings({ available: true, verified: null, external: null }, now)
      .length,
    2,
  );
  assert.match(
    backupWarnings(
      { available: false, verified: null, external: null },
      now,
    )[0],
    /atualização/,
  );
});
test('relatório de backup rejeita outra origem, clínicas inválidas e datas futuras', () => {
  const report = {
    source: 'test.supabase.co',
    clinics: ['aaaaaaaa-0000-4000-8000-000000000001'],
    backup_at: '2026-11-01T00:00:00Z',
    occurred_at: '2026-11-01T00:10:00Z',
  };
  assert.equal(
    validateBackupReport(
      report,
      60,
      'https://test.supabase.co',
      Date.parse('2026-11-02'),
    ),
    report,
  );
  assert.throws(() =>
    validateBackupReport(report, 60, 'https://other.supabase.co'),
  );
  assert.throws(() =>
    validateBackupReport(
      { ...report, clinics: ['invalid'] },
      60,
      'https://test.supabase.co',
    ),
  );
  assert.throws(() =>
    validateBackupReport(
      { ...report, occurred_at: '2999-01-01' },
      60,
      'https://test.supabase.co',
    ),
  );
});
