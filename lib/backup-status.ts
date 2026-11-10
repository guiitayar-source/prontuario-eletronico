export type BackupEvent = {
  id: string;
  backup_at: string;
  occurred_at: string;
  verification_seconds: number | null;
  source: 'scheduled' | 'owner_declaration';
};
export type BackupStatus = {
  available: boolean;
  verified: BackupEvent | null;
  external: BackupEvent | null;
};
/** Limites operacionais de aviso; não representam garantia de recuperação. */
export function backupWarnings(status: BackupStatus, now = Date.now()) {
  if (!status.available)
    return ['O acompanhamento aguarda atualização do banco.'];
  const warnings: string[] = [];
  if (!status.verified)
    warnings.push('Nenhum backup verificado foi comunicado ao painel.');
  else if (now - Date.parse(status.verified.backup_at) > 36 * 3600000)
    warnings.push(
      'O último backup verificado contém dados de mais de 36 horas atrás.',
    );
  if (!status.external) warnings.push('Nenhuma cópia externa foi declarada.');
  else if (now - Date.parse(status.external.backup_at) > 7 * 86400000)
    warnings.push(
      'A última cópia externa declarada contém dados de mais de 7 dias atrás.',
    );
  return warnings;
}
