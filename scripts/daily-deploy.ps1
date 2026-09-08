<#
.SYNOPSIS
  Lấy data D-1 từ BigQuery (bq CLI) → append vào public/data → build local → deploy Vercel.

.DESCRIPTION
  Chạy trên máy Windows của Khanh bằng Windows Task Scheduler. Toàn bộ chuỗi nằm trong
  một script, không còn phụ thuộc scheduled task của Claude hay Chrome.

  Bước lấy data dùng scripts/fetch-daily.mjs (bq CLI của Google Cloud SDK, đăng nhập bằng
  gcloud auth login). Nếu bước này fail, script vẫn đi tiếp nhưng bước kiểm tra manifest
  sẽ thấy chưa có D-1 và bỏ qua deploy, để không deploy đè bản cũ.

.PARAMETER Force
  Bỏ qua kiểm tra D-1, deploy luôn với data đang có.

.PARAMETER SkipDocker
  Không build container local, chỉ deploy Vercel.

.PARAMETER SkipFetch
  Không lấy data từ BigQuery, dùng data đang có trong public/data.

.PARAMETER NoDeploy
  Dừng sau bước lấy data + kiểm tra manifest, không build docker, không deploy Vercel.
  Dùng để chạy thử chuỗi lấy data.

.EXAMPLE
  .\scripts\daily-deploy.ps1
  .\scripts\daily-deploy.ps1 -NoDeploy
  .\scripts\daily-deploy.ps1 -SkipFetch -Force -SkipDocker
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipDocker,
  [switch]$SkipFetch,
  [switch]$NoDeploy
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

# ---- 0. lay data D-1 tu BigQuery (bq CLI, tai khoan gcloud cua user) ----
# Loi o buoc nay KHONG dung script: buoc 1 se thay manifest chua co D-1 va tu bo qua deploy,
# nen production giu data cu thay vi bi deploy de bang chinh data cu.
if ($SkipFetch) {
  Log "bo qua lay data (-SkipFetch)"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Log "khong thay 'node' tren PATH — bo qua lay data" 'WARN'
} else {
  Push-Location $repo
  try {
    # Giong CI: keo cua so 14 ngay dang chay tren production ve truoc, roi chi hoi BigQuery D-1.
    # public/data/ khong con trong git nen may moi clone se trong; khong keo duoc thi lay tron 14 ngay.
    Log "node scripts/pull-prod-data.mjs ..."
    & node (Join-Path $PSScriptRoot 'pull-prod-data.mjs') 2>&1 | ForEach-Object { Log "  pull  | $_" }
    $fetchArgs = @('--days', '1', '--replace-date')
    if ($LASTEXITCODE -ne 0) {
      Log "khong keo duoc data tu production — hoi BigQuery tron 14 ngay" 'WARN'
      $fetchArgs = @('--days', '14', '--replace-date')
    }
    Log "node scripts/fetch-daily.mjs $($fetchArgs -join ' ') ..."
    & node (Join-Path $PSScriptRoot 'fetch-daily.mjs') @fetchArgs 2>&1 | ForEach-Object { Log "  fetch | $_" }
    if ($LASTEXITCODE -eq 2)     { Log "BigQuery chua co dong nao cho D-1 — data nguon chua san. Se bo qua deploy." 'WARN' }
    elseif ($LASTEXITCODE -ne 0) { Log "fetch-daily exit $LASTEXITCODE — xem log o tren (het phien gcloud? chay 'gcloud auth login')." 'WARN' }
    else                          { Log "fetch OK" }
  } finally { Pop-Location }
}

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

if ($NoDeploy) {
  Log "-NoDeploy: data $latest da san sang, dung o day (khong docker, khong vercel)."
  Log "===== ket thuc (NoDeploy) ====="
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

# Cung chuoi voi CI: pull -> build local -> deploy --prebuilt. Khong dung `vercel --prod` (upload
# nguon roi build tren Vercel) vi CLI bo qua file trong .gitignore, ma public/data/ nay da gitignore
# -> ban deploy se KHONG co data. Build local doc thang tu dia nen khong bi anh huong.
Push-Location $repo
try {
  foreach ($step in @(
    @{ n = 'pull';   a = @('pull', '--yes', '--environment=production') },
    @{ n = 'build';  a = @('build', '--prod') },
    @{ n = 'deploy'; a = @('deploy', '--prebuilt', '--prod') }
  )) {
    Log "$vercelCmd $($step.a -join ' ') ..."
    $out = & $vercelCmd @vercelArgs @($step.a) 2>&1
    $out | ForEach-Object { Log "  vercel | $_" }
    if ($LASTEXITCODE -ne 0) {
      Fail "vercel $($step.n) exit $LASTEXITCODE. Neu la loi dang nhap thi chay 'vercel login' mot lan roi thoi."
    }
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
