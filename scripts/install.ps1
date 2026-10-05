#Requires -Version 7
<#
.SYNOPSIS
  pj-prefill 安装助手：把本项目的 plugin.mjs 挂到指定的 preset 组合文件或 profile patch。

.DESCRIPTION
  默认是"演练模式"：只自检 + 打印将要做的改动，不写盘。
  加 -Apply 才真正写盘（写前自动备份 .bak-<时间戳>）。

  只改"挂载行"，不动任何其它内容；不改 profile 的 node_modules（本插件零依赖，
  用 file:// 直接引用，所以不需要 junction、不需要 pnpm）。

.PARAMETER Composition
  要挂载的 preset 组合文件（YAML），默认是 pj-merged 的 clean 版。

.PARAMETER Apply
  真正写盘。

.EXAMPLE
  pwsh -File scripts\install.ps1                    # 演练：看它会改什么
  pwsh -File scripts\install.ps1 -Apply             # 真的装
#>
param(
  [string]$Composition = 'C:\Users\时\.dsh\.agent-presets\pj-merged\agent.cordis.clean.yml',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = 'file:///' + ($root -replace '\\', '/') + '/plugin.mjs'
$lineId = '- id: pj-prefill'

Write-Host '=== pj-prefill 安装助手 ===' -ForegroundColor Cyan
Write-Host ("项目根   : $root")
Write-Host ("入口 URL : $entry")
Write-Host ("目标组合 : $Composition")
Write-Host ''

# ── 1) 自检 ──────────────────────────────────────────────────────────────────
Write-Host '[1/3] 自检' -ForegroundColor Cyan
node --check (Join-Path $root 'plugin.mjs')
if ($LASTEXITCODE -ne 0) { throw 'plugin.mjs 语法检查失败' }
Write-Host '  node --check plugin.mjs  OK'
node (Join-Path $root 'tools\selftest.mjs')
if ($LASTEXITCODE -ne 0) { throw 'selftest 失败 —— 修复后再安装' }
Write-Host ''

# ── 2) 计算改动 ──────────────────────────────────────────────────────────────
Write-Host '[2/3] 计算改动' -ForegroundColor Cyan
if (-not (Test-Path $Composition)) {
  throw "找不到组合文件：$Composition`n（用 -Composition 指定你的 preset 组合文件）"
}
$lines = [System.Collections.Generic.List[string]](Get-Content $Composition)
$idx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i].Trim() -eq $lineId) { $idx = $i; break }
}

$changed = $false
if ($idx -ge 0) {
  # 找到该行的 name: 子行
  $nameIdx = -1
  for ($j = $idx + 1; $j -lt [Math]::Min($idx + 4, $lines.Count); $j++) {
    if ($lines[$j].TrimStart().StartsWith('name:')) { $nameIdx = $j; break }
  }
  if ($nameIdx -lt 0) {
    throw "第 $($idx+1) 行的 pj-prefill 缺少 name: 子行，手工检查该文件"
  }
  $old = $lines[$nameIdx]
  if ($old.Trim() -ne "name: '$entry'") {
    Write-Host "  将替换第 $($nameIdx+1) 行："
    Write-Host "    - $old"
    Write-Host "    + name: '$entry'"
    $lines[$nameIdx] = '  ' + "name: '$entry'"
    $changed = $true
  } else {
    Write-Host '  已指向 plugin.mjs，无需改动'
  }
} else {
  Write-Host '  未找到 pj-prefill 行，将追加：'
  Write-Host "    $lineId"
  Write-Host "      name: '$entry'"
  $lines.Add('')
  $lines.Add('# ── pj-prefill：prefill 攻击注入层（请求层注入 assistant 前缀，不污染历史）──')
  $lines.Add($lineId)
  $lines.Add("  name: '$entry'")
  $changed = $true
}
Write-Host ''

# ── 3) 落盘 ─────────────────────────────────────────────────────────────────
Write-Host '[3/3] 落盘' -ForegroundColor Cyan
if (-not $changed) {
  Write-Host '  无改动。' -ForegroundColor Green
} elseif (-not $Apply) {
  Write-Host '  演练模式：未写盘。确认无误后加 -Apply 重跑。' -ForegroundColor Yellow
} else {
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = "$Composition.bak-$ts-before-pj-prefill"
  Copy-Item $Composition $bak -Force
  Set-Content -Path $Composition -Value $lines -Encoding utf8
  Write-Host "  已写入。备份：$(Split-Path $bak -Leaf)" -ForegroundColor Green
}

Write-Host ''
Write-Host '下一步（本机 pj-merged 的既定生成链）：' -ForegroundColor Cyan
Write-Host '  1) 重跑 preset 生成器与 profile 安装脚本（把 clean.yml 变成 desktop 的 patch 行）'
Write-Host '  2) 新建一个破甲模式会话（不用重启 DSH：file:// 入口换了新文件名 URL）'
Write-Host '  3) 发一条敏感请求，然后跑 scripts\check.ps1 看注入是否发生'
