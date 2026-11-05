// Smoke tests for the desktop window server using a fake `claude` binary.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeclaude-"));
const fake = path.join(dir, "claude");
fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const flags = { web: a.join(" ").includes("WebSearch,WebFetch") && a[a.indexOf("--disallowedTools") + 1] === "Bash,Edit,Write,NotebookEdit", lean: a.includes("--strict-mcp-config") && a.includes("--model"), model: a[a.indexOf("--model") + 1] };
if (process.env.FAKE_OLD && a.includes("--tools")) { console.error("error: unknown option '--tools'"); process.exit(1); }
const reply = (extra) => {
  out({ type: "assistant", session_id: "sess1", message: { content: [{ type: "tool_use", name: "mcp__claudeshape__new_document", input: {} }] } });
  out({ type: "assistant", session_id: "sess1", message: { content: [{ type: "text", text: "Done! https://cad.onshape.com/documents/a/w/b/e/c" }] } });
  out({ type: "result", session_id: "sess1", result: "Done!", is_error: false, ...flags, ...extra });
};
if (a.includes("--input-format")) {                       // persistent mode
  if (process.env.FAKE_BROKEN) { console.error("boom"); process.exit(1); }
  out({ type: "system", subtype: "init", session_id: "sess1" });
  let turn = 0;
  readline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); turn++; reply({ mode: "persistent", turn, pid: process.pid, got: m.message.content }); });
} else {                                                  // one process per message
  if (!a.includes("-p")) process.exit(2);
  out({ type: "system", subtype: "init", session_id: "sess1" });
  reply({ mode: "legacy", resumed: a.includes("--resume") });
}
`.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\nconst readline = require("node:readline");\n'), { mode: 0o755 });

const H = { "content-type": "application/json", "x-claudeshape": "1" };
let port = 4590;
async function server(env = {}) {
  const p = port++;
  const srv = spawn("node", ["gui.js"], { env: { ...process.env, CLAUDE_BIN: fake, CLAUDESHAPE_PORT: String(p), ...env }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 900));
  const post = async (url, body) => (await (await fetch(`http://127.0.0.1:${p}${url}`, { method: "POST", headers: H, body: JSON.stringify(body) })).text()).trim().split("\n").filter(Boolean).map(JSON.parse);
  return { p, srv, post, chat: (prompt, session) => post("/chat", { prompt, session }) };
}
const last = (ev) => ev.at(-1);

// 1. persistent worker: same process serves consecutive messages, context kept
{
  const s = await server();
  assert.match(await (await fetch(`http://127.0.0.1:${s.p}/`)).text(), /ClaudeShape/);
  const a = last(await s.chat("a ball")), b = last(await s.chat("make it bigger"));
  assert.equal(a.mode, "persistent"); assert.equal(a.lean, true); assert.equal(a.web, true);   // web lookups on, file/shell tools off
  assert.equal(a.got, "a ball");
  assert.equal(a.turn, 1); assert.equal(b.turn, 2); assert.equal(b.pid, a.pid);
  // reset starts a fresh process
  await s.post("/reset", {}); await new Promise((r) => setTimeout(r, 500));
  const c = last(await s.chat("new part")); assert.equal(c.turn, 1); assert.notEqual(c.pid, a.pid);
  s.srv.kill();
}
// 2. one-process-per-message fallback keeps working (and resumes sessions)
{
  const s = await server({ CLAUDESHAPE_PERSIST: "0" });
  const a = await s.chat("a ball"); assert.equal(last(a).mode, "legacy"); assert.equal(last(a).resumed, false);
  assert.equal(last(await s.chat("bigger", "sess1")).resumed, true);
  s.srv.kill();
}
// 3. stream mode broken -> transparently falls back to per-message
{
  const s = await server({ FAKE_BROKEN: "1" });
  const a = await s.chat("a ball"); assert.equal(last(a).mode, "legacy"); assert.ok(a.some((e) => JSON.stringify(e).includes("cad.onshape.com")));
  s.srv.kill();
}
// 4. old Claude Code that rejects the usage-saving flags -> retried without them
{
  const s = await server({ FAKE_OLD: "1", CLAUDESHAPE_PERSIST: "0" });
  const a = await s.chat("x"); assert.equal(last(a).type, "result"); assert.equal(last(a).lean, false);
  s.srv.kill();
}
// 4b. reference images are passed to Claude as image blocks ahead of the text; junk is dropped
{
  const s = await server();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const r = last(await s.post("/chat", { prompt: "make this", images: [{ media_type: "image/png", data: png }, { media_type: "text/html", data: png }, { media_type: "image/png", data: "not base64!!" }] }));
  assert.ok(Array.isArray(r.got) && r.got.length === 2, "one valid image + the text");
  assert.deepEqual(r.got[0], { type: "image", source: { type: "base64", media_type: "image/png", data: png } });
  assert.deepEqual(r.got[1], { type: "text", text: "make this" });
  assert.equal(last(await s.post("/chat", { prompt: "plain" })).got, "plain");        // no images: still a plain string
  s.srv.kill();
}
// 4c. the Onshape document is created as soon as the first message arrives (not for follow-ups)
{
  const hits = [];
  const fakeOnshape = (await import("node:http")).createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url.endsWith("/documents")) return res.end(JSON.stringify({ id: "aa", defaultWorkspace: { id: "bb" } }));
    if (req.url.endsWith("/elements")) return res.end(JSON.stringify([{ id: "cc", elementType: "PARTSTUDIO" }]));
    res.end("{}");
  }).listen(4789);
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "pre-"));
  fs.writeFileSync(path.join(T, ".claudeshape.json"), JSON.stringify({ accessKey: "a", secretKey: "b" }));
  const s = await server({ HOME: T, USERPROFILE: T, ONSHAPE_BASE_URL: "http://localhost:4789", CLAUDESHAPE_TMP: T });
  await s.chat("first"); await new Promise((r) => setTimeout(r, 400));
  assert.equal(hits.filter((h) => h.startsWith("POST") && h.endsWith("/documents")).length, 1);
  assert.ok(fs.existsSync(path.join(T, "claudeshape-pending.json")));
  await s.chat("second"); await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits.filter((h) => h.startsWith("POST") && h.endsWith("/documents")).length, 1, "follow-ups must not create another document");
  s.srv.kill(); fakeOnshape.close();
}
// 5. CSRF guard + status
{
  const s = await server();
  const raw = (headers) => fetch(`http://127.0.0.1:${s.p}/chat`, { method: "POST", headers, body: JSON.stringify({ prompt: "x" }) });
  assert.equal((await raw({ "content-type": "application/json" })).status, 403);
  assert.equal((await raw({ ...H, origin: "https://evil.example" })).status, 403);
  assert.equal(typeof (await (await fetch(`http://127.0.0.1:${s.p}/status`)).json()).hasKeys, "boolean");
  s.srv.kill();
}
// 6. missing claude binary -> friendly error
{
  const s = await server({ CLAUDE_BIN: "/nonexistent/claude" });
  const a = await s.chat("x"); assert.match(JSON.stringify(a), /Could not find Claude|stopped unexpectedly/);
  s.srv.kill();
}
console.log("gui smoke passed");
