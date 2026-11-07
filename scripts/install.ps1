# 安装：把插件放进 DSH profile 的 node_modules，并检查 patch 配置。
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   ... -Profile "$env:USERPROFILE\.dsh\profiles\other"
#
# Windows PowerShell 5.1 与 PowerShell 7（pwsh）都可以跑。

[CmdletBinding()]
param(
  # 不传时自动定位当前 profile（DSH_PROFILE_DIR 由 DSH 导出）。
  [string]$Profile,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if (-not $Profile) {
  if ($env:DSH_PROFILE_DIR) {
    $Profile = $env:DSH_PROFILE_DIR
  } elseif ($env:DSH_HOME) {
    $Profile = Join-Path $env:DSH_HOME 'profiles\desktop'
  } else {
    $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
  }
}

# 源码根目录 = 本脚本的上一级
$source = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $source 'package.json'))) {
  throw "找不到 $source\package.json，请从仓库目录里运行这个脚本。"
}

if (-not (Test-Path $Profile)) {
  throw "找不到 profile 目录：$Profile"
}

$target = Join-Path $Profile 'node_modules\dsh-plan-mode'

# 复制：package.json 与 lib/ 是运行时需要的全部内容
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $source 'package.json') $target -Force

$targetLib = Join-Path $target 'lib'
if (Test-Path $targetLib) {
  Remove-Item $targetLib -Recurse -Force
}
Copy-Item (Join-Path $source 'lib') $targetLib -Recurse -Force

$readme = Join-Path $source 'README.md'
if (Test-Path $readme) { Copy-Item $readme $target -Force }

$version = (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version

if (-not $Quiet) {
  Write-Host ""
  Write-Host "已安装 dsh-plan-mode $version" -ForegroundColor Green
  Write-Host "  目标目录: $target"
  Write-Host ""
}

# 检查 patch 里有没有 plan-mode 条目
$patch = Join-Path $Profile 'cordis.patch.yml'
$hasEntry = $false
if (Test-Path $patch) {
  $hasEntry = (Get-Content $patch -Raw) -match 'id:\s*plan-mode'
}

if ($hasEntry) {
  if (-not $Quiet) {
    Write-Host "cordis.patch.yml 里已经有 plan-mode 条目，未改动。" -ForegroundColor Yellow
    Write-Host "接下来：重启 DSH，然后刷新页面（Ctrl+Shift+R）。" -ForegroundColor Yellow
    Write-Host ""
  }
} else {
  Write-Host "cordis.patch.yml 里还没有 plan-mode 条目。" -ForegroundColor Yellow
  Write-Host "把下面这段追加到 $patch 末尾：" -ForegroundColor Yellow
  Write-Host ""
  Write-Host @'
- insert:
    - id: plan-mode
      name: 'dsh-plan-mode'
      config:
        provider: openai-codex
        model: gpt-6.1-sol
        reasoningEffort: high
        maxTokens: 10000
        timeoutMs: 180000
'@
  Write-Host ""
  Write-Host "然后重启 DSH，并刷新页面（Ctrl+Shift+R）。" -ForegroundColor Yellow
  Write-Host "完整配置见 examples\cordis.patch.yml。" -ForegroundColor Yellow
  Write-Host ""
}

if (-not $Quiet) {
  Write-Host "验证：访问 http://127.0.0.1:<当前 GUI 端口>/plugins/dsh-plan-mode/state" -ForegroundColor Cyan
  Write-Host ""
}
