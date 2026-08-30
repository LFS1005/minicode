#!/usr/bin/env bash
# 构建 minicode 便携包:minicode-portable-<version>.tar.gz
# 用法: bash build-portable.sh
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -p "require('./package.json').version")
OUT="minicode-portable-${VERSION}.tar.gz"
TMP=".portable-build"

rm -rf "$TMP"
mkdir -p "$TMP/minicode"

# 只打包运行必需文件
cp -r src "$TMP/minicode/src"
cp package.json "$TMP/minicode/"
cp install.sh "$TMP/minicode/"
cp README.md "$TMP/minicode/"
cp LICENSE "$TMP/minicode/"

tar -czf "$OUT" -C "$TMP" minicode
rm -rf "$TMP"

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ 已生成 $OUT ($SIZE)"

# 列出用法
cat <<'EOF'

安装方式(在目标机器上):
  1) 拷贝本包过去:  tar -xzf <包> && cd minicode && bash install.sh
  2) 或托管后一条命令:
     curl -fsSL https://你的地址/minicode-portable-<version>.tar.gz | tar -xz
     cd minicode && bash install.sh
EOF
