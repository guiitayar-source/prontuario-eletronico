#!/usr/bin/env bash
set -euo pipefail
umask 077
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$PROJECT_DIR"
for command in node docker; do
  command -v "$command" >/dev/null || { printf 'Instale %s antes de continuar.\n' "$command"; exit 1; }
done
[[ -f .env.local && -x node_modules/.bin/supabase ]] || { printf '%s\n' 'Configure .env.local e instale as dependências antes de continuar.'; exit 1; }
node_modules/.bin/supabase status >/dev/null 2>&1 || { printf '%s\n' 'Inicie o Supabase local antes de criar e verificar o backup.'; exit 1; }
BACKUP_DIR="${PSYWRITE_BACKUP_DIR:-$HOME/Backups/PsyWrite}"
mkdir -p -- "$BACKUP_DIR"
trap 'unset PSYWRITE_BACKUP_PASSPHRASE PSYWRITE_DB_URL BACKUP_CONFIRM' EXIT
printf '%s\n' 'Backup do PsyWrite hospedado. As entradas abaixo ficam ocultas.' 'Guarde a senha em seu gerenciador: ela será necessária para restaurar.'
read -rsp 'Senha de backup (mínimo 16 caracteres): ' PSYWRITE_BACKUP_PASSPHRASE
printf '\n'
read -rsp 'Repita a senha: ' BACKUP_CONFIRM
printf '\n'
if [[ "$PSYWRITE_BACKUP_PASSPHRASE" != "$BACKUP_CONFIRM" || ${#PSYWRITE_BACKUP_PASSPHRASE} -lt 16 ]]; then
  printf '%s\n' 'Senhas diferentes ou curtas. Nada foi copiado.'
  exit 1
fi
printf '%s\n' 'No painel Supabase, abra Connect e copie a URI completa de Session pooler (porta 5432), já com a senha embutida.' 'A conexão será usada apenas nesta execução; não será gravada no script.'
read -rsp 'Conexão PostgreSQL: ' PSYWRITE_DB_URL
printf '\n'
export PSYWRITE_BACKUP_PASSPHRASE PSYWRITE_DB_URL
node --env-file=.env.local --input-type=module -e '
import { remoteConnection } from "./scripts/backup-connection.mjs";
try { remoteConnection(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.PSYWRITE_DB_URL); }
catch (error) { console.error(error.message); process.exit(1); }
'
BACKUP_FILE="$BACKUP_DIR/psywrite-$(date -u +%Y%m%dT%H%M%S)-$RANDOM.psybackup"
node --env-file=.env.local scripts/backup.mjs create --remote --file "$BACKUP_FILE"
node scripts/backup.mjs verify --file "$BACKUP_FILE"
printf 'Cópia criada e verificada: %s\n' "$BACKUP_FILE"
