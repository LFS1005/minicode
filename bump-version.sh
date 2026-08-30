#!/usr/bin/env bash
# 递增版本号:0.1.0-BETA1 → 0.1.0-BETA2 → ... → 0.1.0-BETA9
# 每次代码修改后运行本脚本,再 build-portable.sh 重新打包
# 用法: bash bump-version.sh
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -p "require('./package.json').version")

# 提取 BETA 序号(0.1.0-BETA5 → 5;0.1.0 → 0)
NUM=$(node -e "const m = '$VERSION'.match(/BETA(\d+)/); console.log(m ? Number(m[1]) : 0)")
NEXT=$((NUM + 1))

if [ "$NEXT" -gt 9 ]; then
  echo "❌ 已达 BETA9 上限。如需继续,请手动改 package.json 版本号(如 0.2.0)。"
  exit 1
fi

BASE=$(node -e "const v='$VERSION'.replace(/[-_]BETA\d+$/,''); console.log(v || '0.1.0')")
NEW="${BASE}-BETA${NEXT}"
node -e "const fs=require('fs'); const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.version='$NEW'; fs.writeFileSync(p, JSON.stringify(j, null, 2)+'\\n')"

echo "✓ 版本号: $VERSION → $NEW"
echo "  下一步: bash build-portable.sh 重新打包,并提交推送"
