// Smoke test for the desktop window server using a fake `claude` binary.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeclaude-"));
const fake = path.join(dir, "claude");
fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (!a.includes("-p") || !a.includes("--output-format")) process.exit(2);
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: "sess1" });
out({ type: "assistant", session_id: "sess1", message: { content: [{ type: "tool_use", name: "mcp__claudeshape__new_document", input: {} }] } });
out({ type: "assistant", session_id: "sess1", message: { content: [{ type: "text", text: "Done! https://cad.onshape.com/documents/a/w/b/e/c" }] } });
out({ type: "result", session_id: "sess1", result: "Done!", is_error: false, resumed: a.includes("--resume") });
`, { mode: 0o755 });

const srv = spawn("node", ["gui.js"], { env: { ...process.env, CLAUDE_BIN: fake, CLAUDESHAPE_PORT: "4570" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const page = await (await fetch("http://127.0.0.1:4570/")).text();
assert.match(page, /ClaudeShape/);
const post = async (body) => (await (await fetch("http://127.0.0.1:4570/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).text()).trim().split("\n").map(JSON.parse);
const ev = await post({ prompt: "a ball" });
assert.equal(ev[0].session_id, "sess1");
assert.ok(ev.some((e) => JSON.stringify(e).includes("cad.onshape.com")));
assert.equal(ev.at(-1).resumed, false);
assert.equal((await post({ prompt: "make it bigger", session: "sess1" })).at(-1).resumed, true);
// missing claude binary -> friendly error
srv.kill();
const srv2 = spawn("node", ["gui.js"], { env: { ...process.env, CLAUDE_BIN: "/nonexistent/claude", CLAUDESHAPE_PORT: "4571" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const bad = (await (await fetch("http://127.0.0.1:4571/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) })).text());
assert.match(bad, /Could not find Claude Code/);
srv2.kill();
console.log("gui smoke passed");
