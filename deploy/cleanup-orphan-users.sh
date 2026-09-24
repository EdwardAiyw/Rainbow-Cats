#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' '请使用 root 执行此脚本。' >&2
  exit 1
fi

rc_expected=${1:-}
case "$rc_expected" in
  ''|*[!0-9]*) printf '%s\n' '请提供预期删除的孤立账号数量。' >&2; exit 1 ;;
esac

for rc_command in python3 pg_dump pg_restore psql; do
  command -v "$rc_command" >/dev/null || { printf '缺少命令：%s\n' "$rc_command" >&2; exit 1; }
done

rc_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
rc_sql="$rc_script_dir/../server/tools/cleanup-orphan-users.sql"
rc_env=/home/ubuntu/rainbow-cats/server/.env
test -f "$rc_sql"
test -f "$rc_env"

rc_db_url=$(python3 - "$rc_env" <<'PY'
from pathlib import Path
import sys
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key.strip() == 'DATABASE_URL':
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
else:
    raise SystemExit('server/.env 缺少 DATABASE_URL')
PY
)

export RC_CLEANUP_DB_URL="$rc_db_url"
python3 <<'PY'
import os
from urllib.parse import urlsplit
u = urlsplit(os.environ['RC_CLEANUP_DB_URL'])
if u.hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise SystemExit('数据库不在本机，停止清理')
if not (u.path or '').lstrip('/'):
    raise SystemExit('数据库名为空，停止清理')
PY

rc_before=$(psql "$rc_db_url" -Atc 'SELECT count(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.user_id=u.id)')
test "$rc_before" = "$rc_expected" || {
  printf '孤立账号数量已变化：预期 %s，实际 %s。\n' "$rc_expected" "$rc_before" >&2
  exit 1
}

rc_stamp=$(date -u +%Y%m%dT%H%M%SZ)
rc_backup_dir="/opt/rainbow-cats/backups/orphan-cleanup-$rc_stamp"
mkdir -p "$rc_backup_dir"
pg_dump --format=custom --no-owner --file="$rc_backup_dir/database.dump" "$rc_db_url"
pg_restore --list "$rc_backup_dir/database.dump" > "$rc_backup_dir/database.list"

psql "$rc_db_url" -v ON_ERROR_STOP=1 \
  -v expected_count="$rc_expected" -f "$rc_sql" \
  > "$rc_backup_dir/cleanup.log"

rc_after=$(psql "$rc_db_url" -Atc 'SELECT count(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.user_id=u.id)')
test "$rc_after" = 0

printf '已删除 %s 个无空间成员关系的历史账号。\n' "$rc_expected"
printf '操作前数据库备份：%s/database.dump\n' "$rc_backup_dir"
