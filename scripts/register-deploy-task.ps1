<#
.SYNOPSIS
  Dang ky Windows Scheduled Task chay daily-deploy.ps1 hang ngay. Chay MOT LAN roi thoi.

.DESCRIPTION
  Task chay luc 10:15 sang, tuc 15 phut sau khi scheduled task cua Claude ghi data D-1
  vao public/data/. Chi chay khi user dang dang nhap (Docker Desktop va vercel CLI
  deu can session cua user).

.PARAMETER At
  Gio chay, mac dinh 10:15.

.PARAMETER Unregister
  Xoa task da dang ky.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\register-deploy-task.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\register-deploy-task.ps1 -At 11:00
  powershell -ExecutionPolicy Bypass -File .\scripts\register-deploy-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$At = '10:15',
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'EPIC Order Map - daily deploy'
$repo     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $PSScriptRoot 'daily-deploy.ps1'

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Da xoa task '$taskName'." -ForegroundColor Green
  } else {
    Write-Host "Khong co task '$taskName' de xoa." -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $script)) { throw "Khong thay $script" }

# kiem tra dieu kien truoc, de loi hien ra bay gio chu khong phai 10h15 sang mai
Write-Host "Kiem tra moi truong..." -ForegroundColor Cyan
$warn = @()
if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  if (Get-Command npx -ErrorAction SilentlyContinue) { $warn += "Chua co 'vercel' tren PATH, se dung 'npx vercel' (cham hon)." }
  else { throw "Khong thay ca 'vercel' lan 'npx'. Cai Node.js roi 'npm i -g vercel'." }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { $warn += "Chua co 'docker' tren PATH — se bo qua build local, van deploy Vercel." }
if (-not (Test-Path (Join-Path $repo 'public\data\manifest.json'))) { $warn += "Chua thay public/data/manifest.json — chay 'npm run append:data' truoc." }
if (-not (Test-Path (Join-Path $repo '.vercel\project.json'))) { $warn += "Chua thay .vercel/project.json — chay 'vercel link' mot lan." }
foreach ($w in $warn) { Write-Host "  ! $w" -ForegroundColor Yellow }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
             -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

$t = Get-ScheduledTask -TaskName $taskName
$info = $t | Get-ScheduledTaskInfo
Write-Host ""
Write-Host "Da dang ky '$taskName'" -ForegroundColor Green
Write-Host "  chay luc      : $At hang ngay (chi khi may dang bat va da dang nhap)"
Write-Host "  lan chay ke   : $($info.NextRunTime)"
Write-Host "  log           : $repo\logs\deploy-<ngay>.log"
Write-Host ""
Write-Host "Chay thu ngay bay gio:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Go bo:" -ForegroundColor Cyan
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\register-deploy-task.ps1 -Unregister"
