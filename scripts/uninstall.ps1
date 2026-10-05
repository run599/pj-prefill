#Requires -Version 7
<#
.SYNOPSIS
  pj-prefill 卸载：从 preset 组合文件里移除挂载行；可选把项目目录移入回收站。

.DESCRIPTION
  默认只"摘挂载行"（不删任何文件）。要连项目目录一起清掉，加 -Purge。
  按本机铁律：删除一律走回收站，不做永久删除。

.PARAMETER Composition
  组合文件路径（与 install.ps1 保持一致的默认值）。

.PARAMETER Purge
  把项目目录移入回收站（需要交互确认）。

.EXAMPLE
  pwsh -File scripts\uninstall.ps1              # 只摘挂载行
  pwsh -File scripts\uninstall.ps1 -Purge       # 摘行 + 目录进回收站
#>
param(
  [string]$Composition = 'C:\Users\时\.dsh\.agent-presets\pj-merged\agent.cordis.clean.yml',
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lineId = '- id: pj-prefill'

Write-Host '=== pj-prefill 卸载 ===' -ForegroundColor Cyan

# ── 1) 摘掉挂载行 ────────────────────────────────────────────────────────────
if (Test-Path $Composition) {
  $lines = [System.Collections.Generic.List[string]](Get-Content $Composition)
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $lineId) { $idx = $i; break }
  }
  if ($idx -lt 0) {
    Write-Host "  组合文件里没有 pj-prefill 行，跳过。"
  } else {
    # 连同它下面的 name 行、以及紧贴其上的一条注释一起删
    $end = $idx
    while ($end + 1 -lt $lines.Count -and $lines[$end + 1].TrimStart().StartsWith('name:')) { $end++ }
    $start = $idx
    if ($start -gt 0 -and $lines[$start - 1].TrimStart().StartsWith('#') -and $lines[$start - 1] -match 'pj-prefill') { $start-- }
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$Composition.bak-$ts-before-pj-prefill-removal"
    Copy-Item $Composition $bak -Force
    for ($i = $end; $i -ge $start; $i--) { $lines.RemoveAt($i) }
    Set-Content -Path $Composition -Value $lines -Encoding utf8
    Write-Host "  已移除第 $($start+1)-$($end+1) 行。备份：$(Split-Path $bak -Leaf)" -ForegroundColor Green
  }
} else {
  Write-Host "  找不到组合文件：$Composition" -ForegroundColor Yellow
}

# ── 2) 可选：目录进回收站 ────────────────────────────────────────────────────
if ($Purge) {
  Write-Host ''
  Write-Host "将要移入回收站：$root" -ForegroundColor Yellow
  $ans = Read-Host '确认？(输入 YES 继续)'
  if ($ans -ne 'YES') {
    Write-Host '  已取消目录清理。'
  } else {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
      $root, 'OnlyErrorDialogs', 'SendToRecycleBin')
    Write-Host '  已移入回收站（可还原）。' -ForegroundColor Green
  }
} else {
  Write-Host ''
  Write-Host '提示：文件都还在。要连目录一起清掉，重跑并加 -Purge（走回收站）。' -ForegroundColor Cyan
}
