# Started by the ClaudeShape shortcut: update from GitHub, then open the chat window.
$dir = if ($env:CLAUDESHAPE_DIR) { $env:CLAUDESHAPE_DIR } else { Join-Path $env:USERPROFILE "ClaudeShape" }
Set-Location $dir
try { node scripts/update.mjs *> $null } catch {}
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "gui.js" -WorkingDirectory $dir
