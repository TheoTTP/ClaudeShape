#!/bin/bash
# ClaudeShape installer for macOS (and Linux, without the app icon).
#   curl -fsSL https://raw.githubusercontent.com/TheoTTP/ClaudeShape/claude/focused-turing-242l87/install.sh | bash
set -e
REPO="${CLAUDESHAPE_REPO:-https://github.com/TheoTTP/ClaudeShape.git}"
REF="${CLAUDESHAPE_REF:-claude/focused-turing-242l87}"
DIR="${CLAUDESHAPE_DIR:-$HOME/ClaudeShape}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
say() { printf '\n==> %s\n' "$1"; }

say "Checking Git"
if ! command -v git >/dev/null; then
  if [ "$(uname)" = "Darwin" ]; then xcode-select --install 2>/dev/null || true
    echo "A window asked to install developer tools. Finish that, then run this installer again."; exit 1
  fi
  echo "Please install git, then run this again."; exit 1
fi

say "Checking Node.js"
need_node=1
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then need_node=0; fi
if [ $need_node = 1 ]; then
  if command -v brew >/dev/null; then brew install node
  else echo "Install Node.js (the LTS version) from https://nodejs.org , then run this installer again."; exit 1; fi
fi

say "Checking Claude Code"
if ! command -v claude >/dev/null; then curl -fsSL https://claude.ai/install.sh | bash; fi

say "Downloading ClaudeShape"
if [ -d "$DIR/.git" ]; then git -C "$DIR" stash -q || true; git -C "$DIR" fetch -q origin "$REF"; git -C "$DIR" checkout -q "$REF" 2>/dev/null || git -C "$DIR" checkout -q -B "$REF" "origin/$REF"; git -C "$DIR" pull -q --ff-only origin "$REF"
else git clone -q -b "$REF" "$REPO" "$DIR"; fi
(cd "$DIR" && npm install --silent)

if [ "$(uname)" = "Darwin" ]; then
  say "Creating the ClaudeShape app"
  APP="$HOME/Applications/ClaudeShape.app"
  mkdir -p "$HOME/Applications"; rm -rf "$APP"
  osacompile -o "$APP" -e "do shell script \"/bin/bash '$DIR/scripts/launch.sh' >/tmp/claudeshape.log 2>&1 &\""
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
  APP="$APP" DIR="$DIR" osascript -l JavaScript -e 'ObjC.import("AppKit"); var e=$.NSProcessInfo.processInfo.environment; var img=$.NSImage.alloc.initWithContentsOfFile(ObjC.unwrap(e.objectForKey("DIR"))+"/public/icon-512.png"); $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, ObjC.unwrap(e.objectForKey("APP")), 0);' >/dev/null || true
  open -R "$APP" 2>/dev/null || true
  echo "Installed: $APP  (drag it to your Dock if you like)"
else
  echo "Start it with:  bash $DIR/scripts/launch.sh"
fi

cat <<'MSG'

All set. Two things happen the first time you open ClaudeShape:
  1. It asks you to paste an Onshape API key (it walks you through making one).
  2. Claude Code must be signed in once: open Terminal, type  claude  and log in with your Claude account.

If macOS says the app can't be verified, right-click it, choose Open, then Open again.
MSG
