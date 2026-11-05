# ClaudeShape installer for Windows 10/11. Run in PowerShell:
#   irm https://raw.githubusercontent.com/TheoTTP/ClaudeShape/claude/focused-turing-242l87/install.ps1 | iex
$ErrorActionPreference = "Stop"
$Repo = if ($env:CLAUDESHAPE_REPO) { $env:CLAUDESHAPE_REPO } else { "https://github.com/TheoTTP/ClaudeShape.git" }
$Ref  = if ($env:CLAUDESHAPE_REF)  { $env:CLAUDESHAPE_REF }  else { "claude/focused-turing-242l87" }
$Dir  = if ($env:CLAUDESHAPE_DIR)  { $env:CLAUDESHAPE_DIR }  else { Join-Path $env:USERPROFILE "ClaudeShape" }

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.local\bin" }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Winget($id) {
  if (-not (Have winget)) { throw "winget not found. Install $id manually (see the README) and run this again." }
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
}
Refresh-Path

Write-Host "`n==> Checking Git"
if (-not (Have git)) { Winget "Git.Git" }
Write-Host "==> Checking Node.js"
$nodeOk = $false
if (Have node) { $nodeOk = ([int]((node -p "process.versions.node.split('.')[0]")) -ge 20) }
if (-not $nodeOk) { Winget "OpenJS.NodeJS.LTS" }
Write-Host "==> Checking Claude Code"
if (-not (Have claude)) { irm https://claude.ai/install.ps1 | iex; Refresh-Path }

Write-Host "==> Downloading ClaudeShape"
if (Test-Path (Join-Path $Dir ".git")) {
  git -C $Dir stash -q; git -C $Dir fetch -q origin $Ref; git -C $Dir checkout -q $Ref; git -C $Dir pull -q --ff-only origin $Ref
} else { git clone -q -b $Ref $Repo $Dir }
Push-Location $Dir; npm install --silent; Pop-Location

Write-Host "==> Creating the ClaudeShape shortcut"
$ws = New-Object -ComObject WScript.Shell
foreach ($place in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $lnk = $ws.CreateShortcut((Join-Path $place "ClaudeShape.lnk"))
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\scripts\launch.ps1`""
  $lnk.WorkingDirectory = $Dir
  $lnk.IconLocation = "$Dir\public\icon.ico"
  $lnk.WindowStyle = 7
  $lnk.Save()
}

Write-Host @"

All set. A ClaudeShape shortcut is on your Desktop and in the Start menu.
The first time you open it:
  1. It asks you to paste an Onshape API key (it walks you through making one).
  2. Claude Code must be signed in once: open PowerShell, type  claude  and log in with your Claude account.
"@
