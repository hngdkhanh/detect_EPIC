<#
.SYNOPSIS
  Build local + deploy Vercel sau khi scheduled task của Claude đã ghi data D-1.

.DESCRIPTION
  Chạy trên máy Windows của Khanh (không phải sandbox của Claude — sandbox đó không
  tới được vercel.com và không có credential Vercel).

  Script tự bỏ qua nếu public/data/manifest.json chưa có ngày D-1, để không deploy
  đè bản cũ khi task lấy data buổi sáng fail.

.PARAMETER Force
  Bỏ qua kiểm tra D-1, deploy luôn với data đang có.

.PARAMETER SkipDocker
  Không build container local, chỉ deploy Vercel.

.EXAMPLE
  .\scripts\daily-deploy.ps1
  .\scripts\daily-deploy.ps1 -Force -SkipDocker
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipDocker
)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$logDir  = Join-Path $repo 'logs'
$stamp   = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $logDir "deploy-$stamp.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log {
  param([string]$Msg, [string]$Level = 'INFO')
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Fail {
  param([string]$Msg)
  Log $Msg 'ERROR'
  exit 1
}

Log "===== bat dau ====="
Log "repo: $repo"

# ---- 1. data da co D-1 chua ----
$manifestPath = Join-Path $repo 'public\data\manifest.json'
if (-not (Test-Path $manifestPath)) { Fail "Khong thay $manifestPath. Chay 'npm run append:data' truoc." }

try   { $manifest = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json }
catch { Fail "manifest.json hong: $($_.Exception.Message)" }

if (-not $manifest.dates -or $manifest.dates.Count -eq 0) { Fail "manifest.json khong co ngay nao." }

$latest = ($manifest.dates | Sort-Object)[-1]
$tz     = [System.TimeZoneInfo]::FindSystemTimeZoneById('SE Asia Standard Time')
$nowVn  = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
$wantD1 = $nowVn.AddDays(-1).ToString('yyyy-MM-dd')

Log "ngay moi nhat trong manifest: $latest | can co: $wantD1 | tong $($manifest.dates.Count) ngay"

if ($latest -ne $wantD1 -and -not $Force) {
  Log "Chua co data $wantD1 — task lay data sang nay co the da fail. Bo qua deploy." 'WARN'
  Log "Muon deploy voi data dang co thi chay lai voi -Force."
  Log "===== ket thuc (bo qua) ====="
  exit 0
}

# ---- 2. build container local ----
if ($SkipDocker) {
  Log "bo qua docker (-SkipDocker)"
} elseif (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Log "khong thay docker tren PATH — bo qua build local" 'WARN'
} else {
  Log "docker compose up -d --build ..."
  Push-Location $repo
  try {
    & docker compose up -d --build 2>&1 | ForEach-Object { Log "  docker | $_" }
    if ($LASTEXITCODE -ne 0) { Log "docker exit $LASTEXITCODE — van deploy tiep" 'WARN' }
    else { Log "docker OK — http://localhost:8080" }
  } finally { Pop-Location }
}

# ---- 3. deploy Vercel ----
$vercelCmd  = $null
$vercelArgs = @()
if (Get-Command vercel -ErrorAction SilentlyContinue) {
  $vercelCmd = 'vercel'
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
  $vercelCmd  = 'npx'
  $vercelArgs = @('--yes', 'vercel')
  Log "khong thay 'vercel' tren PATH, dung 'npx vercel'" 'WARN'
} else {
  Fail "Khong thay ca 'vercel' lan 'npx'. Cai bang: npm i -g vercel"
}

Log "$vercelCmd --prod ..."
Push-Location $repo
try {
  $out = & $vercelCmd @vercelArgs '--prod' '--yes' 2>&1
  $out | ForEach-Object { Log "  vercel | $_" }
  if ($LASTEXITCODE -ne 0) {
    Fail "vercel exit $LASTEXITCODE. Neu la loi dang nhap thi chay 'vercel login' mot lan roi thoi."
  }
  $url = ($out | Select-String -Pattern 'https://\S+' -AllMatches |
          ForEach-Object { $_.Matches.Value } | Select-Object -Last 1)
  Log "deploy xong: $url"
} finally { Pop-Location }

# ---- 4. don log cu (giu 30 ngay) ----
Get-ChildItem $logDir -Filter 'deploy-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 |
  Remove-Item -Force -ErrorAction SilentlyContinue

Log "===== ket thuc ====="
