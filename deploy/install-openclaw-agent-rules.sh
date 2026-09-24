#!/usr/bin/env bash
set -Eeuo pipefail

rc_rules=${1:-}
test -f "$rc_rules" || { printf '%s\n' '缺少 Rainbow-Cats Agent 规则文件。' >&2; exit 1; }

for rc_workspace in /home/ubuntu/.openclaw/workspace /home/ubuntu/.openclaw/workspace-gf; do
  rc_agents="$rc_workspace/AGENTS.md"
  test -f "$rc_agents" || { printf '工作区规则不存在：%s\n' "$rc_agents" >&2; exit 1; }
  rc_temp=$(mktemp "$rc_workspace/.agents-rainbow.XXXXXX")
  awk '
    /<!-- rainbow-cats-rules:start -->/ { skip=1; next }
    /<!-- rainbow-cats-rules:end -->/ { skip=0; next }
    !skip { print }
  ' "$rc_agents" > "$rc_temp"
  printf '\n' >> "$rc_temp"
  cat "$rc_rules" >> "$rc_temp"
  chmod --reference="$rc_agents" "$rc_temp"
  mv "$rc_temp" "$rc_agents"
done

printf '%s\n' 'Rainbow-Cats Agent 规则已同步到 AI_1 和小暖工作区。'
