# 昔涟博客 —— 本地构建 + 推送到服务器
#
# 为什么本地构建：服务器 2C/1.8G，Astro 构建会吃内存；产物是纯静态，推上去就行。
#
# 用法（仓库根目录）：
#   powershell -File blog/deploy.ps1              # 构建 + 推送 + 远端自检
#   powershell -File blog/deploy.ps1 -SkipBuild   # 跳过构建
#
# ⚠️ 两个已踩过的坑，别改回去：
#   1) 远端脚本用 **base64 传输**：直接 `Get-Content | ssh bash -s` 会带 CRLF，
#      远端报 `$'\r': command not found`；PowerShell 还会吃掉引号和反引号。
#   2) 不用 `Out-File -Encoding utf8`（PS5.1 会写 BOM），改用 .NET 无 BOM 写。

param(
  [switch]$SkipBuild,
  [string]$HostName = $env:ALYSIA_DEPLOY_HOST,
  [string]$RemoteRoot = "/srv/alysia-runner/blog"
)

$ErrorActionPreference = "Stop"
if (-not $HostName) {
  throw "缺 -HostName（或环境变量 ALYSIA_DEPLOY_HOST）；取值见 docs/SERVER-ACCESS-SOP.md"
}

function Invoke-Remote([string]$Script) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Script -replace "`r`n", "`n")))
  ssh -o BatchMode=yes $HostName "echo $b64 | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { throw "远端命令失败（exit=$LASTEXITCODE）" }
}

Push-Location $PSScriptRoot
$tmp = $null
try {
  if (-not $SkipBuild) {
    Write-Host "== 构建 ==" -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "构建失败（$LASTEXITCODE）" }
  }
  if (-not (Test-Path "dist/index.html")) { throw "dist/index.html 不存在" }

  Write-Host "== 打包 ==" -ForegroundColor Cyan
  $tmp = Join-Path $env:TEMP ("blog-dist-" + [guid]::NewGuid().ToString("N") + ".tar.gz")
  tar -czf $tmp -C dist .
  Write-Host ("  {0} MB" -f [math]::Round((Get-Item $tmp).Length / 1MB, 2))

  Write-Host "== 上传 ==" -ForegroundColor Cyan
  scp -o BatchMode=yes $tmp ("{0}:/tmp/blog-dist.tar.gz" -f $HostName)
  if ($LASTEXITCODE -ne 0) { throw "上传失败（$LASTEXITCODE）" }

  Write-Host "== 服务器替换（旧 public 备份）==" -ForegroundColor Cyan
  Invoke-Remote @"
set -eu
cd $RemoteRoot
mkdir -p backups
STAMP=`$(date +%Y%m%d-%H%M%S)
if [ -d public ]; then mv public "backups/public-`$STAMP"; echo "旧 public → backups/public-`$STAMP"; fi
mkdir -p public
tar -xzf /tmp/blog-dist.tar.gz -C public
rm -f /tmp/blog-dist.tar.gz
echo "文件数: `$(find public -type f | wc -l)"
"@

  Write-Host "== 远端自检 ==" -ForegroundColor Cyan
  ssh -o BatchMode=yes $HostName "bash $RemoteRoot/publish.sh --check"

  Write-Host ""
  Write-Host ("完成：{0}/p/alysia-blog/" -f $HostName) -ForegroundColor Green
} finally {
  if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
