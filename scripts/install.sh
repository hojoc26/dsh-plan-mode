#!/usr/bin/env bash
# 安装：把插件放进 DSH profile 的 node_modules，并检查 patch 配置。
#
#   bash scripts/install.sh
#   PLAN_MODE_PROFILE=~/.dsh/profiles/other bash scripts/install.sh
#
set -euo pipefail

# 注意：不能用 DSH_PROFILE —— 那是 DSH 自己导出的变量（值是 profile 名，不是路径）。
if [ -n "${PLAN_MODE_PROFILE:-}" ]; then
  profile="$PLAN_MODE_PROFILE"
elif [ -n "${DSH_PROFILE_DIR:-}" ]; then
  profile="$DSH_PROFILE_DIR"
elif [ -n "${DSH_HOME:-}" ]; then
  profile="$DSH_HOME/profiles/desktop"
else
  profile="$HOME/.dsh/profiles/desktop"
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$source_dir/package.json" ]; then
  echo "找不到 $source_dir/package.json，请从仓库目录里运行这个脚本。" >&2
  exit 1
fi

if [ ! -d "$profile" ]; then
  echo "找不到 profile 目录：$profile" >&2
  exit 1
fi

target="$profile/node_modules/dsh-plan-mode"

# 复制：package.json 与 lib/ 是运行时需要的全部内容
mkdir -p "$target"
cp "$source_dir/package.json" "$target/package.json"
rm -rf "$target/lib"
cp -R "$source_dir/lib" "$target/lib"
[ -f "$source_dir/README.md" ] && cp "$source_dir/README.md" "$target/README.md"

# 从 package.json 里抠版本号：不依赖 node 也不依赖路径转换（Git Bash 的 /c/... 路径 node 不认）
version="$(grep -m1 '"version"' "$source_dir/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
[ -n "$version" ] || version='?'

echo ""
echo "已安装 dsh-plan-mode $version"
echo "  目标目录: $target"
echo ""

patch="$profile/cordis.patch.yml"

if [ -f "$patch" ] && grep -qE 'id:[[:space:]]*plan-mode' "$patch"; then
  echo "cordis.patch.yml 里已经有 plan-mode 条目，未改动。"
  echo "接下来：重启 DSH，然后刷新页面。"
else
  echo "cordis.patch.yml 里还没有 plan-mode 条目。"
  echo "把下面这段追加到 $patch 末尾："
  echo ""
  cat <<'YAML'
- insert:
    - id: plan-mode
      name: 'dsh-plan-mode'
      config:
        provider: openai-codex
        model: gpt-6.1-sol
        reasoningEffort: high
        maxTokens: 10000
        timeoutMs: 180000
YAML
  echo ""
  echo "然后重启 DSH，并刷新页面。"
  echo "完整配置见 examples/cordis.patch.yml。"
fi

echo ""
echo "验证：访问 http://127.0.0.1:<当前 GUI 端口>/plugins/dsh-plan-mode/state"
echo ""
