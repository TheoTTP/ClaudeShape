// Find the Claude Code binary to use. Prefer the one bundled with the Claude desktop app
// (so friends who already use the desktop app are already signed in), then `claude` on PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exe = process.platform === "win32" ? "claude.exe" : "claude";
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function newestFirst(names) {
  const num = (s) => s.replace(/^v/, "").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  return [...names].sort((a, b) => {
    const A = num(a), B = num(b);
    for (let i = 0; i < Math.max(A.length, B.length); i++) if ((B[i] || 0) !== (A[i] || 0)) return (B[i] || 0) - (A[i] || 0);
    return 0;
  });
}

// look for a file named `claude`/`claude.exe` up to `depth` folders below dir
function findIn(dir, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === exe) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) if (e.isDirectory()) { const r = findIn(path.join(dir, e.name), depth - 1); if (r) return r; }
  return null;
}

export function desktopAppClaude() {
  const home = os.homedir();
  const roots = process.platform === "darwin" ? [path.join(home, "Library/Application Support/Claude/claude-code")]
    : process.platform === "win32" ? [path.join(process.env.APPDATA || "", "Claude", "claude-code"), path.join(process.env.LOCALAPPDATA || "", "Claude", "claude-code")]
    : [path.join(home, ".config/Claude/claude-code")];
  for (const root of roots) {
    let vers; try { vers = fs.readdirSync(root); } catch { continue; }
    for (const v of newestFirst(vers)) { const f = findIn(path.join(root, v)); if (f) return f; }
  }
  return null;
}

export function pathClaude() {
  for (const d of (process.env.PATH || "").split(path.delimiter)) { const f = path.join(d, exe); if (d && isFile(f)) return f; }
  for (const d of [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]) { const f = path.join(d, exe); if (isFile(f)) return f; }
  return null;
}

/** Ordered list of binaries to try. An explicit CLAUDE_BIN means "only this one". */
export function claudeCandidates() {
  if (process.env.CLAUDE_BIN) return [process.env.CLAUDE_BIN];
  const list = [desktopAppClaude(), pathClaude()].filter(Boolean);
  return [...new Set(list)];
}

if (process.argv[1] && process.argv[1].endsWith("claude-bin.js") && process.argv.includes("--check")) {
  console.log(claudeCandidates()[0] || "");
}
