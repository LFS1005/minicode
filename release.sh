#!/usr/bin/env bash
# 一键发布:递增版本 → 打包 → 推 tag → 创建 GitHub Release 并上传整合包
# 用法: bash release.sh
# 前置:已安装 gh 并登录(gh auth login),仅需一次;之后的 tag/Release 全自动
set -euo pipefail

cd "$(dirname "$0")"

# 1) 递增版本号(BETA1 → BETA9)
VERSION=$(node -p "require('./package.json').version")
# 提取 BETA 序号
NUM=$(node -e "const m='$VERSION'.match(/BETA(\d+)/); console.log(m ? Number(m[1]) : 0)")
if [ "$NUM" -ge 9 ]; then
  echo "❌ 已达 BETA9 上限,请手动改 package.json 版本号(如 0.2.0-BETA1)。"
  exit 1
fi
BASE=$(node -e "const v='$VERSION'.replace(/[-_]?BETA\d+$/,''); console.log(v || '0.1.0')")
NEW="${BASE}-BETA$((NUM + 1))"
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('package.json','utf8'));j.version='$NEW';fs.writeFileSync('package.json',JSON.stringify(j,null,2)+'\n')"
echo "✓ 版本: $VERSION → $NEW"
VERSION="$NEW"

# 2) 打包
echo "✓ 重新打包..."
bash build-portable.sh >/dev/null
PACKAGE="minicode-portable-${VERSION}.tar.gz"
[ -f "$PACKAGE" ] || { echo "❌ 包未生成"; exit 1; }

# 3) 提交版本变更并打 tag
git add package.json
git commit -m "release: v${VERSION}" >/dev/null 2>&1 || echo "(无 package.json 变更待提交)"
git push origin main
git tag -f "v${VERSION}"
git push origin "v${VERSION}"

# 4) 创建 Release 并上传整合包
echo "✓ 上传 Release v${VERSION}..."
gh release create "v${VERSION}" "$PACKAGE" \
  --title "minicode ${VERSION}" \
  --notes "便携整合包:$PACKAGE
构建命令:tar -xzf $PACKAGE && cd minicode && bash install.sh"

echo "✅ 完成:https://github.com/LFS1005/minicode/releases"