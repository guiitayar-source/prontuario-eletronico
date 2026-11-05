export function validateBackupReport(report, duration, api, now = Date.now()) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !report ||
    report.source !== new URL(api).hostname ||
    !Array.isArray(report.clinics) ||
    report.clinics.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
    new Set(report.clinics).size !== report.clinics.length ||
    !Number.isInteger(duration) ||
    duration < 0 ||
    duration > 604800
  )
    throw new Error('Relatório inválido.');
  const start = Date.parse(report.backup_at),
    end = Date.parse(report.occurred_at);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    end > now
  )
    throw new Error('Datas inválidas.');
  return report;
}
