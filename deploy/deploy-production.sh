#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' '请使用 root 执行此脚本。' >&2
  exit 1
fi

for rc_command in docker python3 pg_dump pg_restore psql createdb dropdb curl caddy systemctl sudo ss tar timeout; do
  command -v "$rc_command" >/dev/null || { printf '缺少命令：%s\n' "$rc_command" >&2; exit 1; }
done
docker info >/dev/null
docker compose version >/dev/null

rc_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
rc_release_dir=$(cd -- "$rc_script_dir/.." && pwd)
rc_live_dir=/home/ubuntu/rainbow-cats
rc_live_env="$rc_live_dir/server/.env"
rc_caddy_file=/etc/caddy/Caddyfile
rc_stamp=$(date -u +%Y%m%dT%H%M%SZ)
rc_backup_dir="/opt/rainbow-cats/backups/$rc_stamp"
rc_release_target="/opt/rainbow-cats/releases/$rc_stamp"
rc_stage_db="rainbow_predeploy_${rc_stamp//[^0-9A-Za-z]/_}"
rc_project=rainbow-cats
rc_port=3101
rc_current_link=/opt/rainbow-cats/current
rc_switched=0
rc_stage_created=0
rc_success=0
rc_openclaw_version=''
rc_validation_container=''
rc_candidate_started=0
rc_previous_managed=0
rc_previous_release=''
rc_previous_tag=''
rc_previous_container=''

mkdir -p "$rc_backup_dir" "$rc_release_target"
rc_log="$rc_backup_dir/deploy.log"
exec > >(tee -a "$rc_log") 2>&1

rc_user_systemctl() {
  sudo -u ubuntu env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"
}

rc_postgres() {
  (cd /tmp && sudo -u postgres "$@")
}

rc_compose() {
  RELEASE_TAG="$rc_stamp" RAINBOW_PORT="$rc_port" OPENCLAW_VERSION="$rc_openclaw_version" \
    docker compose -p "$rc_project" -f "$rc_release_target/compose.production.yaml" "$@"
}

rc_previous_compose() {
  RELEASE_TAG="$rc_previous_tag" RAINBOW_PORT="$rc_port" OPENCLAW_VERSION="$rc_openclaw_version" \
    docker compose -p "$rc_project" -f "$rc_previous_release/compose.production.yaml" "$@"
}

rc_restore_caddy() {
  if [ -f "$rc_backup_dir/Caddyfile" ]; then
    cp "$rc_backup_dir/Caddyfile" "$rc_caddy_file" \
      && caddy validate --config "$rc_caddy_file" \
      && systemctl reload caddy
  fi
}

rc_restore_previous_container() {
  printf '正在恢复上一版本容器：%s\n' "$rc_previous_tag" >&2
  rc_previous_compose up -d --no-build app || return 1
  for rc_restore_attempt in $(seq 1 60); do
    if curl --max-time 3 -fsS "http://127.0.0.1:$rc_port/api/v1/health" >/dev/null; then
      ln -sfn "$rc_previous_release" "$rc_current_link" || return 1
      return 0
    fi
    if [ "$rc_restore_attempt" -eq 60 ]; then
      rc_previous_compose logs --tail=100 app >&2 || true
      return 1
    fi
    sleep 2
  done
}

rc_cleanup() {
  rc_status=$?
  trap - EXIT ERR INT TERM
  if [ "$rc_success" -ne 1 ]; then
    printf '部署失败（退出码 %s）。\n' "$rc_status" >&2
    if [ "$rc_previous_managed" -eq 1 ]; then
      if [ "$rc_candidate_started" -eq 1 ]; then
        rc_restore_previous_container || printf '%s\n' '自动恢复上一容器失败，请立即人工检查。' >&2
      fi
      if [ "$rc_switched" -eq 1 ]; then rc_restore_caddy || true; fi
    else
      if [ "$rc_switched" -eq 1 ]; then
        rc_user_systemctl start rainbow-cats.service || true
        rc_restore_caddy || true
      fi
      if [ "$rc_candidate_started" -eq 1 ] && [ -f "$rc_release_target/compose.production.yaml" ]; then
        rc_compose down --remove-orphans || true
      fi
    fi
    printf '旧站点已保留或恢复。日志：%s\n' "$rc_log" >&2
  fi
  if [ -n "$rc_validation_container" ]; then
    docker rm -f "$rc_validation_container" >/dev/null 2>&1 || true
  fi
  if [ "$rc_stage_created" -eq 1 ]; then
    rc_postgres dropdb --if-exists "$rc_stage_db" || true
  fi
  exit "$rc_status"
}
trap rc_cleanup EXIT ERR INT TERM

printf '%s\n' '[1/9] 检查当前部署'
test -f "$rc_live_env"
test -f "$rc_caddy_file"
test -f "$rc_release_dir/server/schema.sql"
test -f "$rc_release_dir/server/migrations/001_live_upgrade.sql"

if [ -e "$rc_current_link" ]; then
  rc_previous_release=$(readlink -f "$rc_current_link")
  if [ -f "$rc_previous_release/compose.production.yaml" ]; then
    rc_previous_tag=$(basename "$rc_previous_release")
    rc_previous_container=$(
      RELEASE_TAG="$rc_previous_tag" RAINBOW_PORT="$rc_port" OPENCLAW_VERSION='' \
        docker compose -p "$rc_project" -f "$rc_previous_release/compose.production.yaml" ps -q app 2>/dev/null || true
    )
    if [ -n "$rc_previous_container" ] \
      && [ "$(docker inspect --format '{{.State.Running}}' "$rc_previous_container" 2>/dev/null || true)" = true ] \
      && [ "$(docker inspect --format '{{.Config.Image}}' "$rc_previous_container" 2>/dev/null || true)" = "rainbow-cats:$rc_previous_tag" ]; then
      rc_previous_managed=1
    fi
  fi
fi

if ss -H -lnt "sport = :$rc_port" | grep -q .; then
  if [ "$rc_previous_managed" -eq 1 ] \
    && curl --max-time 5 -fsS "http://127.0.0.1:$rc_port/api/v1/health" >/dev/null; then
    printf '检测到正在运行的受管版本 %s，将执行安全升级。\n' "$rc_previous_tag"
  else
    printf '端口 %s 被非受管或异常进程占用，停止部署。\n' "$rc_port" >&2
    exit 1
  fi
fi

rc_db_url=$(python3 - "$rc_live_env" <<'PY'
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
export RC_DB_URL="$rc_db_url"
readarray -t rc_db_parts < <(python3 <<'PY'
import os
from urllib.parse import urlsplit, unquote
u = urlsplit(os.environ['RC_DB_URL'])
if u.hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise SystemExit('正式数据库不是本机数据库，停止自动部署')
print(unquote(u.username or ''))
print((u.path or '/').lstrip('/'))
PY
)
rc_db_user=${rc_db_parts[0]}
rc_db_name=${rc_db_parts[1]}
test -n "$rc_db_user"
test -n "$rc_db_name"
rc_stage_url=$(python3 - "$rc_stage_db" <<'PY'
import os, sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(os.environ['RC_DB_URL'])
print(urlunsplit((u.scheme, u.netloc, '/' + sys.argv[1], u.query, u.fragment)))
PY
)

rc_openclaw_enabled=$(python3 - "$rc_live_env" <<'PY'
from pathlib import Path
import sys
values = {}
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip("\"'").lower()
recipe_enabled = values.get('OPENCLAW_RECIPE_ENABLED', 'false') == 'true'
chat_enabled = values.get('OPENCLAW_CHAT_CLI_ENABLED', '')
if not chat_enabled:
    chat_enabled = str(recipe_enabled).lower()
print(str(recipe_enabled or chat_enabled == 'true').lower())
PY
)
rc_openclaw_model=$(python3 - "$rc_live_env" <<'PY'
from pathlib import Path
import sys
values = {}
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip("\"'")
print(values.get('OPENCLAW_CHAT_MODEL') or values.get('OPENCLAW_RECIPE_MODEL') or 'deepseek/deepseek-v4-flash')
PY
)
if [ "$rc_openclaw_enabled" = true ]; then
  install -d -o ubuntu -g ubuntu -m 700 /home/ubuntu/.openclaw/state
  rc_openclaw_bin=''
  for rc_candidate in /usr/local/bin/openclaw /usr/bin/openclaw /home/ubuntu/.local/bin/openclaw /home/ubuntu/.openclaw/bin/openclaw; do
    if [ -x "$rc_candidate" ]; then rc_openclaw_bin=$rc_candidate; break; fi
  done
  if [ -z "$rc_openclaw_bin" ]; then
    rc_openclaw_bin=$(sudo -u ubuntu -H bash -lc 'command -v openclaw' 2>/dev/null || true)
  fi
  test -x "$rc_openclaw_bin" || { printf '%s\n' 'OpenClaw 推理已启用，但未找到宿主机 openclaw 命令。' >&2; exit 1; }
  rc_openclaw_version=$(sudo -u ubuntu "$rc_openclaw_bin" --version 2>&1 | grep -Eo '[0-9]{4}\.[0-9]+\.[0-9]+[^[:space:]]*' | head -1 || true)
  test -n "$rc_openclaw_version" || { printf '%s\n' '无法确定宿主机 OpenClaw 版本。' >&2; exit 1; }
  printf '将容器内 OpenClaw 固定为 %s。\n' "$rc_openclaw_version"
fi

printf '%s\n' '[2/9] 备份源码、配置、Caddy 和数据库'
cp "$rc_caddy_file" "$rc_backup_dir/Caddyfile"
cp "$rc_live_env" "$rc_backup_dir/server.env"
tar --exclude='rainbow-cats/server/node_modules' --exclude='rainbow-cats/.git' -czf "$rc_backup_dir/live-source.tar.gz" -C /home/ubuntu rainbow-cats
pg_dump --format=custom --no-owner --file="$rc_backup_dir/database.dump" "$rc_db_url"
pg_restore --list "$rc_backup_dir/database.dump" >/dev/null

printf '%s\n' '[3/9] 准备不可变发布目录并构建镜像'
tar --exclude='server/.env' --exclude='*/node_modules' --exclude='*/node_modules/*' \
  -cf - -C "$rc_release_dir" \
  .dockerignore Dockerfile.production compose.production.yaml README.md server web deploy \
  | tar -xf - -C "$rc_release_target"
cp "$rc_live_env" "$rc_release_target/server/.env"
chmod 600 "$rc_release_target/server/.env"
RELEASE_TAG="$rc_stamp" OPENCLAW_VERSION="$rc_openclaw_version" docker compose -p "$rc_project" -f "$rc_release_target/compose.production.yaml" build app
docker build -t "rainbow-cats-browser-check:$rc_stamp" "$rc_release_target/deploy/browser"

printf '%s\n' '[4/9] 用正式数据副本验证迁移'
rc_postgres createdb --owner="$rc_db_user" "$rc_stage_db"
rc_stage_created=1
pg_restore --no-owner --dbname="$rc_stage_url" "$rc_backup_dir/database.dump"
psql "$rc_stage_url" --single-transaction -v ON_ERROR_STOP=1 -f "$rc_release_target/server/schema.sql"
psql "$rc_stage_url" --single-transaction -v ON_ERROR_STOP=1 -f "$rc_release_target/server/migrations/001_live_upgrade.sql"

printf '%s\n' '[5/9] 在正式数据副本上运行回归和 API 联调'
rc_test_port=3417
while ss -H -lnt "sport = :$rc_test_port" | grep -q .; do rc_test_port=$((rc_test_port + 1)); done
docker run --rm --network host \
  -e DATABASE_URL="$rc_stage_url" \
  -e PORT="$rc_test_port" \
  -e TEST_PORT="$rc_test_port" \
  -e HOST='127.0.0.1' \
  -e WEB_ORIGIN="http://127.0.0.1:$rc_test_port" \
  -e SESSION_SECRET='isolated-predeploy-validation' \
  -e TIANAPI_KEY='' \
  -e OPENCLAW_RECIPE_ENABLED='false' \
  "rainbow-cats:$rc_stamp" \
  sh -c 'npm run check && node --check /app/web/app.js && npm run test:web && npm run test:api && npm run audit:db'

rc_browser_port=$((rc_test_port + 1))
while ss -H -lnt "sport = :$rc_browser_port" | grep -q .; do rc_browser_port=$((rc_browser_port + 1)); done
rc_validation_container="rainbow-predeploy-${rc_stamp,,}"
docker run -d --name "$rc_validation_container" --network host \
  -e DATABASE_URL="$rc_stage_url" \
  -e PORT="$rc_browser_port" \
  -e HOST='127.0.0.1' \
  -e WEB_ORIGIN="http://127.0.0.1:$rc_browser_port" \
  -e SESSION_SECRET='isolated-browser-validation' \
  -e TIANAPI_KEY='' \
  -e OPENCLAW_RECIPE_ENABLED='false' \
  "rainbow-cats:$rc_stamp" >/dev/null
for rc_attempt in $(seq 1 30); do
  if curl --max-time 3 -fsS "http://127.0.0.1:$rc_browser_port/api/v1/health" >/dev/null; then break; fi
  if [ "$rc_attempt" -eq 30 ]; then docker logs "$rc_validation_container"; exit 1; fi
  sleep 1
done
mkdir -p "$rc_backup_dir/browser"
docker run --rm --network host --ipc=host \
  -e BASE_URL="http://127.0.0.1:$rc_browser_port" \
  -v "$rc_backup_dir/browser:/output" \
  "rainbow-cats-browser-check:$rc_stamp"
docker rm -f "$rc_validation_container" >/dev/null
rc_validation_container=''

printf '%s\n' '[6/9] 迁移正式数据库并启动候选容器'
psql "$rc_db_url" --single-transaction -v ON_ERROR_STOP=1 -f "$rc_release_target/server/schema.sql"
psql "$rc_db_url" --single-transaction -v ON_ERROR_STOP=1 -f "$rc_release_target/server/migrations/001_live_upgrade.sql"
rc_candidate_started=1
rc_compose up -d --no-build app
for rc_attempt in $(seq 1 60); do
  if curl --max-time 3 -fsS "http://127.0.0.1:$rc_port/api/v1/health" > "$rc_backup_dir/candidate-health.json"; then break; fi
  if [ "$rc_attempt" -eq 60 ]; then rc_compose logs --tail=100 app; exit 1; fi
  sleep 2
done
python3 - "$rc_backup_dir/candidate-health.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
assert payload.get('ok') is True and payload.get('data', {}).get('database') == 'ready', payload
PY

if [ "$rc_openclaw_enabled" = true ]; then
  printf '%s\n' '[7/9] 验证容器内 OpenClaw CLI 与 Gateway 连通性'
  rc_candidate_container=$(rc_compose ps -q app)
  test -n "$rc_candidate_container"
  docker exec "$rc_candidate_container" openclaw --version
  timeout --kill-after=5s 30s docker exec "$rc_candidate_container" openclaw gateway status \
    > "$rc_backup_dir/openclaw-gateway-status.txt"
  grep -q 'Connectivity probe: ok' "$rc_backup_dir/openclaw-gateway-status.txt" \
    || { printf '%s\n' 'OpenClaw CLI 无法连接本机 Gateway。' >&2; exit 1; }
else
  printf '%s\n' '[7/9] OpenClaw 未启用，跳过 CLI Gateway 测试'
fi

printf '%s\n' '[8/9] 更新并验证 Caddy 路由'
rc_switched=1
python3 - "$rc_caddy_file" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text().splitlines()
out = []
in_target = False
depth = 0
found = False
blocked = False
for line in lines:
    stripped = line.strip()
    if not in_target and stripped.startswith('rainbow.251104.xyz') and stripped.endswith('{'):
        in_target = True
        depth = line.count('{') - line.count('}')
        out.append(line)
        continue
    if in_target:
        if stripped.startswith('@rainbowInternal '):
            blocked = True
        if stripped.startswith('reverse_proxy '):
            if not blocked:
                indent = line[:len(line)-len(line.lstrip())]
                out.append(f'{indent}@rainbowInternal path /api/internal/*')
                out.append(f'{indent}respond @rainbowInternal 404')
                blocked = True
            indent = line[:len(line)-len(line.lstrip())]
            out.append(f'{indent}reverse_proxy 127.0.0.1:3101')
            found = True
        else:
            out.append(line)
        depth += line.count('{') - line.count('}')
        if depth == 0:
            in_target = False
        continue
    out.append(line)
if not found:
    raise SystemExit('未找到 rainbow.251104.xyz 的 reverse_proxy')
p.write_text('\n'.join(out) + '\n')
PY
caddy validate --config "$rc_caddy_file"
systemctl reload caddy
for rc_attempt in $(seq 1 30); do
  if curl --max-time 8 -fsS 'https://rainbow.251104.xyz/api/v1/health' > "$rc_backup_dir/public-health.json"; then break; fi
  if [ "$rc_attempt" -eq 30 ]; then exit 1; fi
  sleep 2
done
python3 - "$rc_backup_dir/public-health.json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
assert payload.get('ok') is True and payload.get('data', {}).get('database') == 'ready', payload
PY
rc_internal_status=$(curl --max-time 8 -sS -o /dev/null -w '%{http_code}' 'https://rainbow.251104.xyz/api/internal/openclaw/resolve')
test "$rc_internal_status" = 404 || { printf '内部接口公网状态码应为 404，实际为 %s。\n' "$rc_internal_status" >&2; exit 1; }

printf '%s\n' '[9/9] 完成切换并生成回退脚本'
if [ "$rc_previous_managed" -eq 1 ]; then
  cat > "$rc_backup_dir/rollback.sh" <<ROLLBACK
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "\$(id -u)" -ne 0 ]; then echo '请使用 root 执行'; exit 1; fi
previous_release='$rc_previous_release'
previous_tag='$rc_previous_tag'
test -f "\$previous_release/compose.production.yaml"
test -f "\$previous_release/server/.env"
docker image inspect "rainbow-cats:\$previous_tag" >/dev/null
RELEASE_TAG="\$previous_tag" RAINBOW_PORT='$rc_port' OPENCLAW_VERSION='' docker compose -p '$rc_project' -f "\$previous_release/compose.production.yaml" up -d --no-build app
for attempt in \$(seq 1 60); do
  if curl --max-time 3 -fsS 'http://127.0.0.1:$rc_port/api/v1/health' >/dev/null; then break; fi
  if [ "\$attempt" -eq 60 ]; then
    RELEASE_TAG="\$previous_tag" RAINBOW_PORT='$rc_port' OPENCLAW_VERSION='' docker compose -p '$rc_project' -f "\$previous_release/compose.production.yaml" logs --tail=100 app
    exit 1
  fi
  sleep 2
done
cp '$rc_backup_dir/Caddyfile' '$rc_caddy_file'
caddy validate --config '$rc_caddy_file'
systemctl reload caddy
ln -sfn "\$previous_release" '$rc_current_link'
sudo -u ubuntu env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user stop rainbow-cats.service || true
curl --max-time 10 -fsS 'https://rainbow.251104.xyz/api/v1/health'
echo "已回退到上一容器版本 \$previous_tag；数据库扩展保持向后兼容。"
ROLLBACK
else
  cat > "$rc_backup_dir/rollback.sh" <<ROLLBACK
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "\$(id -u)" -ne 0 ]; then echo '请使用 root 执行'; exit 1; fi
sudo -u ubuntu env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user start rainbow-cats.service
cp '$rc_backup_dir/Caddyfile' '$rc_caddy_file'
caddy validate --config '$rc_caddy_file'
systemctl reload caddy
RELEASE_TAG='$rc_stamp' RAINBOW_PORT='$rc_port' OPENCLAW_VERSION='$rc_openclaw_version' docker compose -p '$rc_project' -f '$rc_release_target/compose.production.yaml' down
if [ "\$(readlink -f '$rc_current_link' 2>/dev/null || true)" = '$rc_release_target' ]; then rm -f '$rc_current_link'; fi
curl --max-time 10 -fsS 'https://rainbow.251104.xyz/api/v1/health'
echo '已回退到原 systemd 服务；数据库扩展保持兼容，无需恢复数据。'
ROLLBACK
fi
chmod 700 "$rc_backup_dir/rollback.sh"
rc_user_systemctl stop rainbow-cats.service
rc_postgres dropdb --if-exists "$rc_stage_db"
rc_stage_created=0
ln -sfn "$rc_release_target" "$rc_current_link"
rc_success=1
trap - EXIT ERR INT TERM
printf '部署成功：https://rainbow.251104.xyz\n'
printf '备份与回退脚本：%s\n' "$rc_backup_dir"
printf '需要回退时运行：bash %s/rollback.sh\n' "$rc_backup_dir"
