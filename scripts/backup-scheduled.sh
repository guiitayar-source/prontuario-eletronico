#!/usr/bin/env bash
# Backup diário sem interação, chamado pelo timer do systemd (scripts/systemd/).
# Lê a senha do backup e a conexão do banco de ~/.config/psywrite/backup.env (permissão 600).
# Sobe o Supabase local só para o ensaio de restauração e o desliga se foi ele quem subiu.
set -euo pipefail
umask 077
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$PROJECT_DIR"
SECRETS="${PSYWRITE_BACKUP_ENV:-$HOME/.config/psywrite/backup.env}"
BACKUP_DIR="${PSYWRITE_BACKUP_DIR:-$HOME/Backups/PsyWrite}"
KEEP="${PSYWRITE_BACKUP_KEEP:-30}"

fail() {
  printf '%s\n' "$1" >&2
  command -v notify-send >/dev/null && notify-send -u critical 'Backup do PsyWrite falhou' "$1" || true
  exit 1
}

[[ -f "$SECRETS" ]] || fail "Arquivo de segredos ausente: $SECRETS"
[[ "$(stat -c %a "$SECRETS")" == 600 && "$(stat -c %u "$SECRETS")" == "$(id -u)" ]] \
  || fail "Proteja $SECRETS: chmod 600 e dono $(id -un)."
[[ -f .env.local && -x node_modules/.bin/supabase ]] || fail 'Configure .env.local e instale as dependências.'
command -v docker >/dev/null || fail 'Docker não encontrado.'

set -a
# shellcheck source=/dev/null
source "$SECRETS"
set +a
trap 'unset PSYWRITE_BACKUP_PASSPHRASE PSYWRITE_DB_URL PASSPHRASE' EXIT
PASSPHRASE="${PSYWRITE_BACKUP_PASSPHRASE:-}"
[[ ${#PASSPHRASE} -ge 16 && -n "${PSYWRITE_DB_URL:-}" ]] \
  || fail "Defina PSYWRITE_BACKUP_PASSPHRASE (16+) e PSYWRITE_DB_URL em $SECRETS."
# Mesma checagem do assistente: o motivo aparece aqui, sem expor a senha.
node --env-file=.env.local --input-type=module -e '
import { remoteConnection } from "./scripts/backup-connection.mjs";
try { remoteConnection(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.PSYWRITE_DB_URL); }
catch (error) { console.error(error.message); process.exit(1); }
' || fail "PSYWRITE_DB_URL inválida em $SECRETS: use a URI do Session pooler (porta 5432) com a senha do banco no lugar de [YOUR-PASSWORD]."

STARTED=0
if ! node_modules/.bin/supabase status >/dev/null 2>&1; then
  node_modules/.bin/supabase start >/dev/null || fail 'Não foi possível iniciar o Supabase local.'
  STARTED=1
fi
trap 'unset PSYWRITE_BACKUP_PASSPHRASE PSYWRITE_DB_URL; [[ $STARTED == 1 ]] && node_modules/.bin/supabase stop >/dev/null 2>&1 || true' EXIT

mkdir -p -- "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/psywrite-$(date -u +%Y%m%dT%H%M%S)-$RANDOM.psybackup"
node --env-file=.env.local scripts/backup.mjs create --remote --file "$BACKUP_FILE" \
  || { rm -f -- "$BACKUP_FILE"; fail 'Falha ao criar a cópia. Veja: journalctl --user -u psywrite-backup'; }
node scripts/backup.mjs verify --file "$BACKUP_FILE" \
  || fail "Cópia criada, mas a verificação falhou: $BACKUP_FILE"

# Mantém só as $KEEP cópias mais recentes; nunca apaga a que acabou de ser verificada.
mapfile -t old < <(ls -1t -- "$BACKUP_DIR"/psywrite-*.psybackup | tail -n +"$((KEEP + 1))")
((${#old[@]})) && rm -f -- "${old[@]}"
printf 'Cópia criada e verificada: %s\n' "$BACKUP_FILE"
