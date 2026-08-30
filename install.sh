#!/usr/bin/env bash
# minicode 便携安装脚本
# 零依赖:仅复制文件 + 创建启动命令 + 配置全局环境变量,无需编译,支持 Linux(含 armv7)/ macOS / Windows(Git Bash)
#
# 用法:
#   本地:   bash install.sh
#   远程:   curl -fsSL <URL> | bash
# 自定义目录: MINICODE_INSTALL_DIR=/opt/minicode bash install.sh
# 同时配置 API: MINICODE_API_KEY=sk-xxx MINICODE_BASE_URL=https://... MINICODE_MODEL=xxx bash install.sh
#   (不传则跳过 API 环境变量,之后可用 /config 向导配置)

set -euo pipefail

# ---------- 定位源码目录 ----------
# 远程管道执行时没有脚本路径,此时认为"当前目录就是源码"或使用预置变量
if [[ -n "${MINICODE_SRC_DIR:-}" ]]; then
  SRC_DIR="$MINICODE_SRC_DIR"
elif [[ "${BASH_SOURCE[0]:-}" != "" && -f "$(dirname "${BASH_SOURCE[0]}")/src/index.js" ]]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SRC_DIR="$(pwd)"
fi

# ---------- 安装目录 ----------
INSTALL_DIR="${MINICODE_INSTALL_DIR:-$HOME/.minicode}"
BIN_DIR="${MINICODE_BIN_DIR:-$HOME/.local/bin}"

# ---------- 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 Node.js。请先安装 Node.js 18+ (https://nodejs.org)" >&2
  echo "  armv7 Linux: https://nodejs.org/dist/ (选 linux-armv7l 包)" >&2
  exit 1
fi

# ---------- 复制源码 ----------
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/src"
cp -r "$SRC_DIR/src" "$INSTALL_DIR/src"
cp "$SRC_DIR/package.json" "$INSTALL_DIR/package.json" 2>/dev/null || true
cp "$SRC_DIR/LICENSE" "$INSTALL_DIR/LICENSE" 2>/dev/null || true

# ---------- 平台检测 ----------
IS_WINDOWS=0
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

# ---------- 创建启动命令 ----------
if [[ $IS_WINDOWS -eq 1 ]]; then
  # Windows(Git Bash/MSYS):路径转成 Windows 格式,生成 .cmd 供 cmd/PowerShell 调用
  # 同时生成 POSIX 启动脚本,供 Git Bash 直接使用
  WIN_INSTALL="$(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")"
  cat > "$INSTALL_DIR/minicode.cmd" <<EOF
@echo off
node "$WIN_INSTALL\\src\\index.js" %*
EOF
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/minicode" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/src/index.js" "\$@"
EOF
  chmod +x "$BIN_DIR/minicode"
else
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/minicode" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/src/index.js" "\$@"
EOF
  chmod +x "$BIN_DIR/minicode"
fi

echo "✓ 已安装到 $INSTALL_DIR"

# ============================================================
# 全局环境变量配置(安装后免去每次手动 export/setx)
# ============================================================

# ---------- 1. PATH 永久化 ----------
persist_path() {
  if [[ $IS_WINDOWS -eq 1 ]]; then
    # Windows:写用户级 PATH(注册表 HKCU\Environment),新终端立即生效
    local win_dir
    win_dir="$(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")"
    if command -v powershell >/dev/null 2>&1; then
      local cur
      cur="$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','User')" 2>/dev/null | tr -d '\r')"
      if [[ ";$cur;" == *";$win_dir;"* ]]; then
        echo "  ✓ 用户 PATH 已包含 $win_dir"
      else
        local new_path="$cur"
        # 只在 PATH 非空且不以分号结尾时补分号;避免拼到最后一个条目后面
        if [[ -n "$new_path" && "$new_path" != *";" ]]; then
          new_path="$new_path;"
        fi
        new_path="${new_path}${win_dir}"
        # 用 PowerShell 写回(避免 setx 截断到 1024 字符的问题)
        powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path','$new_path','User')" >/dev/null 2>&1
        echo "  ✓ 已把 $win_dir 写入用户 PATH(新开终端生效)"
      fi
    else
      # 没有 PowerShell 时退回 setx(注意 setx 会把 PATH 截断到 1024 字符)
      cmd //c "setx Path \"%Path%;$win_dir\"" >/dev/null 2>&1 && \
        echo "  ✓ 已用 setx 把 $win_dir 加入 PATH(新开终端生效)" || \
        echo "  ⚠ 自动写 PATH 失败,请手动: setx Path \"%Path%;$win_dir\""
    fi
  else
    # POSIX:写入 shell 配置(去重)
    local marker="# minicode PATH"
    local line="export PATH=\"$BIN_DIR:\$PATH\""
    local written=0 # 0=尚未写入过(需要 fallback),1=已处理(含已存在匹配)
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [[ -f "$rc" ]] || continue
      if grep -qF "$BIN_DIR" "$rc" 2>/dev/null; then
        written=1
        continue
      fi
      printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"
      echo "  ✓ 已把 $BIN_DIR 写入 $rc"
      written=1
    done
    if [[ $written -eq 0 ]]; then
      # 没有任何 rc 文件且均未写入:创建 .profile
      printf '\n%s\n%s\n' "$marker" "$line" >> "$HOME/.profile"
      echo "  ✓ 已把 $BIN_DIR 写入 $HOME/.profile"
    fi
    echo "  (当前终端执行: export PATH=\"$BIN_DIR:\$PATH\" 立即生效;之后新终端自动生效)"
  fi
}

# ---------- 2. API 环境变量(仅安装时显式传入才写入) ----------
persist_api_env() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || return 0
  if [[ $IS_WINDOWS -eq 1 ]]; then
    if command -v powershell >/dev/null 2>&1; then
      # 转义单引号(PowerShell 用两个单引号转义),避免破坏命令
      local safe
      safe="$(printf '%s' "$value" | sed "s/'/''/g")"
      powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('$name','$safe','User')" >/dev/null 2>&1 && \
        echo "  ✓ 已写入用户环境变量 $name" || \
        echo "  ⚠ 写入 $name 失败"
    else
      # setx 分支:转义双引号与 & | < > ^
      local safe
      safe="$(printf '%s' "$value" | sed 's/[&|<>^]/^&/g; s/"/\\"/g')"
      cmd //c "setx $name \"$safe\"" >/dev/null 2>&1 && \
        echo "  ✓ 已用 setx 写入 $name" || \
        echo "  ⚠ 写入 $name 失败"
    fi
  else
    local marker="# minicode env"
    if ! grep -qF "export $name=" "$HOME/.profile" 2>/dev/null; then
      printf '\n%s\nexport %s="%s"\n' "$marker" "$name" "$value" >> "$HOME/.profile"
    else
      # 已有同名变量:更新值
      sed -i.bak "s|^export $name=.*|export $name=\"$value\"|" "$HOME/.profile" && rm -f "$HOME/.profile.bak"
    fi
    echo "  ✓ 已写入 $HOME/.profile: export $name=***"
  fi
}

echo ""
echo "--- 全局环境变量 ---"
persist_path
persist_api_env MINICODE_API_KEY "${MINICODE_API_KEY:-}"
persist_api_env MINICODE_BASE_URL "${MINICODE_BASE_URL:-}"
persist_api_env MINICODE_MODEL "${MINICODE_MODEL:-}"
if [[ -z "${MINICODE_API_KEY:-}" && -z "${MINICODE_BASE_URL:-}" ]]; then
  echo "  (未提供 MINICODE_API_KEY/BASE_URL/MODEL,跳过 API 环境变量;"
  echo "   之后在 minicode 里输入 /config 配置即可)"
fi

echo ""
echo "开始使用: minicode   (新开一个终端,或先 export PATH)"
