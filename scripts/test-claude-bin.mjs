import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const bin = path.join(home, "pathbin"); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH; delete process.env.CLAUDE_BIN;
const { claudeCandidates } = await import("../lib/claude-bin.js");

// only on PATH
assert.deepEqual(claudeCandidates(), [path.join(bin, "claude")]);
// desktop app copies (nested like the real thing, newest version wins) are preferred over PATH
const root = process.platform === "darwin" ? path.join(home, "Library/Application Support/Claude/claude-code") : path.join(home, ".config/Claude/claude-code");
for (const v of ["2.1.9", "2.1.10", "2.0.99"]) { fs.mkdirSync(path.join(root, v, "x"), { recursive: true }); fs.writeFileSync(path.join(root, v, "x", "claude"), "", { mode: 0o755 }); }
const c = claudeCandidates();
assert.equal(c[0], path.join(root, "2.1.10", "x", "claude"));
assert.equal(c[1], path.join(bin, "claude"));
console.log("claude-bin tests passed");
