# Started by the ClaudeShape shortcut: update from GitHub, then open the chat window.
$dir = if ($env:CLAUDESHAPE_DIR) { $env:CLAUDESHAPE_DIR } else { Join-Path $env:USERPROFILE "ClaudeShape" }
$env:Path += ";$env:USERPROFILE\.local\bin"
Set-Location $dir
try { git stash -q; git pull -q --ff-only; npm install --silent } catch {}
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "gui.js" -WorkingDirectory $dir
