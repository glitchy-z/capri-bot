$wd = $PSScriptRoot
$pidFile = Join-Path $wd 'bot.pid'

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Write-Host "bot is already running (pid $old)"
    exit
  }
}

$p = Start-Process powershell `
  -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','runner.ps1') `
  -WorkingDirectory $wd -WindowStyle Hidden -PassThru
$p.Id | Set-Content $pidFile
Write-Host "bot started in background (pid $($p.Id))"
Write-Host "logs: bot.log  |  view with: npm run logs  |  stop with: npm run stop"
