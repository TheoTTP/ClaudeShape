#!/bin/bash
# Started by the ClaudeShape app: update from GitHub, then open the chat window.
# Wrapped in a function so an update can't change this file out from under bash mid-run.
main() {
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  cd "${CLAUDESHAPE_DIR:-$HOME/ClaudeShape}" || exit 1
  node scripts/update.mjs >/dev/null 2>&1
  exec node gui.js
}
main
exit
