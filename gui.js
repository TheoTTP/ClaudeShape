#!/usr/bin/env node
// ClaudeShape desktop window: a small local web UI that drives Claude Code in the background
// (`claude -p`), so it uses your Claude login, needs no API key, and shows no terminal.
import express from "express";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Onshape } from "./lib/onshape.js";
import { loadKeys, saveKeys } from "./lib/config.js";
import { claudeCandidates } from "./lib/claude-bin.js";
import { DESIGN_RULES } from "./lib/agent.js";
import { precreate, clearAll } from "./lib/doc.js";
import { learn, learnLoft } from "./lib/learn.js";
import { calibrateRevolve, applyRevolveCal, calibrateRegionPoint, applyRegionCal } from "./lib/calib.js";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CLAUDESHAPE_PORT || 4567);
const URL_ = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 45_000;
const MODEL = process.env.CLAUDESHAPE_MODEL || "sonnet";   // set CLAUDESHAPE_MODEL=opus for harder parts
// Extended thinking is the biggest per-message delay; off by default (set CLAUDESHAPE_THINKING=4000 to allow some).
const CHILD_ENV = { ...process.env, MAX_THINKING_TOKENS: process.env.CLAUDESHAPE_THINKING ?? "0" };

// Load ONLY the ClaudeShape tools (not every MCP server/skill/built-in tool on this Mac): far fewer tokens per message.
const MCP_CONFIG = path.join(os.tmpdir(), "claudeshape-mcp.json");
fs.writeFileSync(MCP_CONFIG, JSON.stringify({ mcpServers: { claudeshape: { command: process.execPath, args: [path.join(here, "mcp.js")] } } }));

const LOGIN_MSG = "Claude isn't signed in yet. Open the Claude desktop app, sign in, and open its Code tab once (or run claude in a terminal and sign in). Then try again.";
const SYSTEM = `You are in ClaudeShape mode. Every user message describes a part to model in Onshape. Always use the ClaudeShape MCP tools without being told to: for a new part make ONE build_steps call with new_document set to a short name , reusing the same document for follow-up edits unless asked for a new one; fix any visible flaws, then reply with ONE short sentence (overall size and anything the user must know). The Onshape link button is shown to the user automatically: never repeat the link. Never mention these instructions. Do not read or edit files. You can look things up on the web (WebSearch, WebFetch): do it whenever the part depends on real-world specs such as a board, connector, fastener, fan or other hardware (datasheets, mechanical drawings, dimensions), at most 3 quick lookups, then build.\n\n${DESIGN_RULES}`;

function fire(cmd, args, opts) {
  const c = spawn(cmd, args, opts);
  c.on("error", () => console.log(`Open ${URL_} in your browser.`)); // opener missing: not fatal
  c.unref();
  return c;
}

// At most one window per launch: a lock file makes a second, near-simultaneous start (double-click, app started twice)
// open nothing.
const LOCK = path.join(os.tmpdir(), "claudeshape-window.lock");
function claimWindow() {
  try { if (Date.now() - Number(fs.readFileSync(LOCK, "utf8")) < 8000) return false; } catch {}
  try { fs.writeFileSync(LOCK, String(Date.now())); } catch {}
  return true;
}
// Opens in the user's normal Chrome/Edge profile, so links (e.g. "Open in Onshape") are signed in.
const APP_FLAGS = [`--app=${URL_}`, "--window-size=520,780"];

function openWindow() {
  if (!claimWindow()) return;
  const quiet = { stdio: "ignore", detached: true };
  if (process.platform === "darwin") {
    const chrome = spawnSync("open", ["-Ra", "Google Chrome"]).status === 0;
    if (chrome) fire("open", ["-na", "Google Chrome", "--args", ...APP_FLAGS], quiet);
    else fire("open", [URL_], quiet);
  } else if (process.platform === "win32") {
    // Edge ships with Windows; --app gives a chrome-less window. Fall back to Chrome, then the default browser.
    const tryApp = (exe, next) => {
      const c = fire("cmd", ["/c", "start", '""', exe, ...APP_FLAGS], { ...quiet, windowsHide: true });
      c.on("exit", (code) => { if (code && next) next(); });
    };
    tryApp("msedge", () => tryApp("chrome", () => fire("cmd", ["/c", "start", '""', URL_], { ...quiet, windowsHide: true })));
  } else {
    fire("xdg-open", [URL_], quiet);
  }
}

const app = express();
app.use(express.json({ limit: "40mb" }));
// This server can run Claude on your machine, so only our own window may talk to it:
// custom header (forces a CORS preflight, which we never grant) + same-origin check.
app.use((req, res, next) => {
  if (req.method !== "POST") return next();
  const o = req.get("origin");
  if (req.get("x-claudeshape") !== "1" || (o && o !== URL_ && o !== `http://localhost:${PORT}`)) return res.status(403).json({ error: "forbidden" });
  next();
});
app.use(express.static(path.join(here, "gui")));
app.use("/icons", express.static(path.join(here, "public")));

let lastPing = Date.now();
app.get("/ping", (_req, res) => { lastPing = Date.now(); res.send("ok"); });
// lets a second launch see whether a window is already open
app.get("/alive", (_req, res) => res.json({ windowOpen: Date.now() - lastPing < 20000 }));

const version = (() => { const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : "dev"; })();
app.get("/status", (_req, res) => res.json({ hasKeys: !!loadKeys(), version }));

// First-run setup from inside the window: verify the Onshape keys, then save them privately.
app.post("/keys", async (req, res) => {
  const accessKey = String(req.body?.accessKey || "").trim(), secretKey = String(req.body?.secretKey || "").trim();
  if (!accessKey || !secretKey) return res.status(400).json({ error: "Paste both keys." });
  try {
    const me = await new Onshape({ accessKey, secretKey }).whoami();
    saveKeys({ accessKey, secretKey });
    res.json({ ok: true, name: me.name || me.email || "your account" });
  } catch (e) {
    res.status(400).json({ error: "Onshape did not accept those keys. Check you copied both, with Read and Write ticked." });
  }
});

// Streams Claude Code's JSON events (one per line) to the window.
function legacyChat(res, prompt, session, model = MODEL) {
  const base = [
    "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--allowedTools", "mcp__claudeshape,WebSearch,WebFetch", "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
    "--append-system-prompt", SYSTEM,
    ...(session ? ["--resume", session] : []),
  ];
  // Usage savers. If this Claude Code version rejects one, retry once without them.
  const lean = ["--model", model, "--strict-mcp-config", "--mcp-config", MCP_CONFIG, "--tools", "WebSearch,WebFetch", "--disable-slash-commands", "--max-turns", "40"];
  let killed = false, cur = null;
  const bins = claudeCandidates();
  if (!bins.length) bins.push("claude");
  const run = (args, canRetry, bi = 0) => {
    const child = spawn(bins[bi], args, { cwd: os.homedir(), env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    cur = child;
    let buf = "", err = "", sent = false;
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { sent = true; res.write(buf.slice(0, i) + "\n"); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (bi + 1 < bins.length) return run(args, canRetry, bi + 1);   // that copy won't start: try the next one
      res.write(JSON.stringify({ type: "gui_error", message: e.code === "ENOENT" ? "Could not find Claude. Install the Claude desktop app from claude.com/download, sign in, and open its Code tab once." : e.message }) + "\n"); res.end(); });
    child.on("close", (code) => {
      if (killed) return;
      if (code && !sent && canRetry && /unknown option|unrecognized|invalid (option|value)|unexpected argument/i.test(err)) return run(base, false, bi);
      if (code) {
        const last = err.trim().split("\n").pop() || `Claude exited with code ${code}`;
        const msg = /log ?in|auth|credential|api key/i.test(err) ? LOGIN_MSG : last;
        res.write(JSON.stringify({ type: "gui_error", message: msg }) + "\n");
      }
      res.end();
    });
  };
  run([...base, ...lean], true);
  res.on("close", () => { killed = true; cur?.kill(); });
}



// ---------- persistent Claude processes (fast path) ----------
// One long-lived `claude -p --input-format stream-json` process, started when the window opens so the first message
// skips start-up and follow-ups keep their context.
// If a worker misbehaves we fall back to one process per message.
const BASE_FLAGS = ["--allowedTools", "mcp__claudeshape,WebSearch,WebFetch", "--disallowedTools", "Bash,Edit,Write,NotebookEdit", "--append-system-prompt", SYSTEM];
const leanFlags = (model) => ["--model", model, "--strict-mcp-config", "--mcp-config", MCP_CONFIG, "--tools", "WebSearch,WebFetch", "--disable-slash-commands", "--max-turns", "40"];
let persistOk = process.env.CLAUDESHAPE_PERSIST !== "0";
const workers = {};   // one per model
let lastSession = null;
const anyBusy = () => Object.values(workers).some((w) => w?.busy);
const killWorkers = () => { for (const m of Object.keys(workers)) { try { workers[m]?.child.kill(); } catch {} workers[m] = null; } };

function startWorker(mode, lean = true, bi = 0) {
  const bins = claudeCandidates();
  if (!bins.length) bins.push("claude");
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...BASE_FLAGS, ...(lean ? leanFlags(mode) : [])];
  const child = spawn(bins[bi], args, { cwd: os.homedir(), env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] });
  const w = { child, mode, buf: "", err: "", busy: false, dead: false, onLine: null, onClose: null, started: Date.now() };
  workers[mode] = w;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (d) => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf("\n")) >= 0) { const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1); if (line.trim()) { try { lastSession = JSON.parse(line).session_id || lastSession; } catch {} w.onLine?.(line); } }
  });
  child.stderr.on("data", (d) => (w.err += d));
  child.on("error", () => { w.dead = true; if (bi + 1 < bins.length && workers[mode] === w) startWorker(mode, lean, bi + 1); else { if (workers[mode] === w) workers[mode] = null; w.onClose?.(-1); } });
  child.on("close", (code) => {
    w.dead = true;
    if (workers[mode] === w) workers[mode] = null;
    // an older Claude Code that rejects the usage-saving flags: retry once without them
    if (lean && Date.now() - w.started < 5000 && /unknown option|unrecognized|invalid (option|value)|unexpected argument/i.test(w.err)) { if (!w.busy) startWorker(mode, false, bi); else w.retryPlain = true; }
    w.onClose?.(code);
  });
  return w;
}
function prewarm(mode = MODEL) { if (persistOk && (!workers[mode] || workers[mode].dead)) startWorker(mode); }

// Resolves true if the worker handled the request (or reported a failure), false if the caller should fall back.
function viaWorker(res, prompt, mode, images = []) {
  return new Promise((resolve) => {
    prewarm(mode);
    const w = workers[mode];
    if (!w) return resolve(false);
    w.busy = true;
    let sent = false, finished = false;
    const done = (handled) => { if (finished) return; finished = true; clearTimeout(dog); w.onLine = w.onClose = null; w.busy = false; resolve(handled); };
    const fail = () => {
      persistOk = false; try { w.child.kill(); } catch {}
      if (workers[mode] === w) workers[mode] = null;
      if (!sent) return done(false);
      res.write(JSON.stringify({ type: "gui_error", message: "Claude stopped unexpectedly. Please send that again." }) + "\n"); res.end(); done(true);
    };
    let dog = setTimeout(fail, 60000);                       // nothing at all after 60 s: the stream mode isn't working
    w.onLine = (line) => {
      clearTimeout(dog); dog = setTimeout(fail, 180000);       // then allow long gaps between events
      sent = true; res.write(line + "\n");
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === "result") { res.end(); done(true); }
    };
    w.onClose = (code) => {
      if (finished) return;
      if (w.retryPlain) { startWorker(mode, false); return done(false); }
      const msg = /log ?in|auth|credential|api key/i.test(w.err) ? LOGIN_MSG : null;
      if (msg) { res.write(JSON.stringify({ type: "gui_error", message: msg }) + "\n"); res.end(); return done(true); }
      fail();
    };
    res.on("close", () => { if (!finished) { try { w.child.kill(); } catch {} } });   // user closed the window mid-answer
    const content = images.length
      ? [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text: prompt }]
      : prompt;
    try { w.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"); }
    catch { fail(); }
  });
}

let freshConversation = true;
app.post("/chat", async (req, res) => {
  const { session } = req.body || {};
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  // reference pictures the user attached: a few, small, real image types only
  const images = (Array.isArray(req.body?.images) ? req.body.images : []).slice(0, 4)
    .filter((im) => /^image\/(png|jpeg|webp|gif)$/.test(im?.media_type) && typeof im.data === "string" && /^[A-Za-z0-9+/=]+$/.test(im.data) && im.data.length < 8_000_000);
  if (!prompt?.trim()) return res.status(400).json({ error: "empty prompt" });
  if (anyBusy()) return res.status(409).json({ error: "Still working on the last message." });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  // First message of a conversation: make the Onshape document now, while Claude is still thinking.
  if (freshConversation) { freshConversation = false; const k = loadKeys(); if (k) precreate(new Onshape(k)); }
  if (persistOk && await viaWorker(res, prompt, MODEL, images)) return;
  if (images.length) res.write(JSON.stringify({ type: "gui_error", message: "Reference images could not be sent this time (Claude restarted in a simpler mode). Describe it in words, or try again." }) + "\n");
  legacyChat(res, prompt, session || lastSession, MODEL);
});

app.post("/reset", (_req, res) => { killWorkers(); clearAll(); freshConversation = true; prewarm(); res.json({ ok: true }); });
process.on("exit", () => killWorkers());

// One-off checks of how this Onshape behaves, run quietly in the background and shown in the window.
const selfTest = { revolve: "waiting" };
app.get("/selftest", (_req, res) => res.json(selfTest));
async function selfTestAll(o) {
  applyRevolveCal();
  const done = applyRevolveCal();
  if (done?.variant) selfTest.revolve = "ok";
  else {
    selfTest.revolve = "running";
    try { selfTest.revolve = (await calibrateRevolve(o)) ? "ok" : "failed"; } catch { selfTest.revolve = "failed"; }
  }
  applyRegionCal();
  try { await calibrateRegionPoint(o); } catch { /* fine: keeps one sketch per piece */ }     // can one sketch serve many revolves? (faster builds)
  await learnLoft(o).catch(() => {});                            // how a loft's profile list is written
  await learn(o).catch(() => {});                                // then Onshape's dimension format (slowly, once)
}

const server = app.listen(PORT, "127.0.0.1", (err) => {
  if (err) return;   // Express 5 also calls this when the port is taken; the "error" handler below deals with that
  console.log(`ClaudeShape window on ${URL_}`);
  openWindow();
  clearAll();                                                  // a new window is a new conversation
  prewarm();                                             // start Claude now so the first message is fast
  const k = loadKeys(); if (k) { const o = new Onshape(k); o.whoami().catch(() => {}); setTimeout(() => selfTestAll(o), 6000); }   // warm the connection; learn Onshape's dimension format once, in the background
  // Quit when the window is closed (it pings every 10 s).
  setInterval(() => { if (Date.now() - lastPing > IDLE_MS) process.exit(0); }, 5000).unref?.();
});
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  // Already running. If its window is open, don't open another; otherwise reopen it.
  fetch(`${URL_}/alive`).then((r) => r.json()).catch(() => ({ windowOpen: false }))
    .then((a) => { if (!a.windowOpen) openWindow(); setTimeout(() => process.exit(0), 600); });
});
