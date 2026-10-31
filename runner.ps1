# runs inside a hidden powershell window; restarts the bot if it ever crashes
Set-Location $PSScriptRoot
# node writes utf-8 (the qr block chars need it) — decode it as utf-8, not the oem codepage
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  node bot.js *>> bot.log
  Add-Content bot.log "=== bot exited $(Get-Date), restarting in 5s ==="
  Start-Sleep -Seconds 5
}
