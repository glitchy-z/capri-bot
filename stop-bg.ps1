$pidFile = Join-Path $PSScriptRoot 'bot.pid'

if (-not (Test-Path $pidFile)) {
  Write-Host 'bot is not running (no pid file)'
  exit
}

$id = Get-Content $pidFile
if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
  # /T kills the runner and the node process under it
  taskkill /PID $id /T /F | Out-Null
  Write-Host "bot stopped (pid $id)"
} else {
  Write-Host 'bot was not running'
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
