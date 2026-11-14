#Requires -Version 7
<#
.SYNOPSIS
  pj-prefill 运行状态检查：读日志与状态快照，打印可核对的客观事实。

.DESCRIPTION
  这个脚本回答的问题只有三个：
    1. 插件挂载过吗（boot 行）？
    2. 注入真的发生了吗（inject 行、次数、前几条文本）？
    3. 没注入时是什么原因（skip 行的 why 分布）？

.PARAMETER Tail
  显示最近多少条 inject 记录（默认 5）。
#>
param(
  [int]$Tail = 5
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'prefill.log'
$state = Join-Path $root 'state.json'

Write-Host '=== pj-prefill 状态 ===' -ForegroundColor Cyan
Write-Host ("项目根 : $root")

# ── 文件时间 ─────────────────────────────────────────────────────────────────
if (Test-Path $log) {
  $fi = Get-Item $log
  Write-Host ("日志   : $log  ($($fi.Length) 字节, 最后写入 $($fi.LastWriteTime))")
} else {
  Write-Host "日志   : 不存在 —— 插件从未挂载过（或从未被 pre-step 触发）" -ForegroundColor Yellow
}

# ── 统计 ─────────────────────────────────────────────────────────────────────
if (Test-Path $log) {
  $rows = @()
  foreach ($line in Get-Content $log) {
    if (-not $line.Trim()) { continue }
    try { $rows += ($line | ConvertFrom-Json) } catch { }
  }
  Write-Host ''
  Write-Host ("总记录 : $($rows.Count)")

  $boots = @($rows | Where-Object { $_.ev -eq 'boot' })
  $injects = @($rows | Where-Object { $_.ev -eq 'inject' })
  $errors = @($rows | Where-Object { $_.ev -eq 'error' })
  $skips = @($rows | Where-Object { $_.ev -eq 'skip' })

  Write-Host ("挂载   : $($boots.Count) 次") -ForegroundColor $(if ($boots.Count -gt 0) { 'Green' } else { 'Yellow' })
  if ($boots.Count -gt 0) {
    $b = $boots[-1]
    Write-Host ("  最近一次: v$($b.version)  enabled=$($b.enabled)  文本池来源=$($b.textPoolSource)")
  }
  Write-Host ("注入   : $($injects.Count) 次") -ForegroundColor $(if ($injects.Count -gt 0) { 'Green' } else { 'Yellow' })
  Write-Host ("错误   : $($errors.Count) 次") -ForegroundColor $(if ($errors.Count -gt 0) { 'Red' } else { 'Green' })

  if ($skips.Count -gt 0) {
    Write-Host '跳过原因分布：'
    $skips | Group-Object why | Sort-Object Count -Descending | ForEach-Object {
      Write-Host ("  {0,-22} {1}" -f $_.Name, $_.Count)
    }
  }

  if ($injects.Count -gt 0) {
    Write-Host ''
    Write-Host "最近 $Tail 次注入：" -ForegroundColor Cyan
    $injects | Select-Object -Last $Tail | ForEach-Object {
      $stripped = if ($_.stripped) { " 剔除旧prefill=$($_.stripped)" } else { '' }
      Write-Host ("  [$($_.ts)] seq=$($_.seq) step=$($_.step) group=$($_.group) roles=$($_.roles) $($_.msgCount)$stripped")
      Write-Host ("      文本: $($_.text)")
      if ($_.session) { Write-Host ("      会话: $($_.session)") }
    }
  }

  Write-Host ''
  Write-Host '判定：' -ForegroundColor Cyan
  if ($boots.Count -eq 0) {
    Write-Host '  ✗ 插件没挂载 —— 检查 preset 里是否有 pj-prefill 行、以及入口 URL 是否指向 plugin.mjs' -ForegroundColor Red
  } elseif ($injects.Count -eq 0 -and $skips.Count -gt 0) {
    Write-Host '  ⚠ 挂载了但一次都没注入 —— 看上面的跳过原因分布' -ForegroundColor Yellow
  } elseif ($injects.Count -gt 0) {
    Write-Host '  ✓ 注入链路正常' -ForegroundColor Green
  }
}

# ── 状态快照 ─────────────────────────────────────────────────────────────────
Write-Host ''
if (Test-Path $state) {
  Write-Host '=== state.json 快照 ===' -ForegroundColor Cyan
  Get-Content $state -Raw
} else {
  Write-Host 'state.json 不存在（还没有注入过）' -ForegroundColor Yellow
}

# ── 当前配置 ─────────────────────────────────────────────────────────────────
$cfg = Join-Path $root 'config\settings.json'
if (Test-Path $cfg) {
  Write-Host ''
  Write-Host '=== 当前配置（config\settings.json）===' -ForegroundColor Cyan
  Get-Content $cfg -Raw
}
