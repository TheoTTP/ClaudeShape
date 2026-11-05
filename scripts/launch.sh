#!/bin/bash
# Started by the ClaudeShape app: update from GitHub, then open the chat window.
# Wrapped in a function so `git pull` can't change this file out from under bash mid-run.
main() {
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  cd "${CLAUDESHAPE_DIR:-$HOME/ClaudeShape}" || exit 1
  { git stash -q; git pull -q --ff-only; npm install --silent; } >/dev/null 2>&1
  exec node gui.js
}
main
exit
