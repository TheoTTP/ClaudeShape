#!/usr/bin/env node
// ClaudeShape desktop window: a small local web UI that drives Claude Code in the background
// (`claude -p`), so it uses your Claude login, needs no API key, and shows no terminal.
import express from "express";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CLAUDESHAPE_PORT || 4567);
const URL_ = `http://127.0.0.1:${PORT}`;
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const IDLE_MS = 45_000;

const SYSTEM = `You are in ClaudeShape mode. Every user message describes a part to model in Onshape. Always use the ClaudeShape MCP tools without being told to: call new_document first unless the user gives an Onshape URL (and reuse the same document for follow-up edits), build the part, check it with get_bounding_box, then reply with the Onshape link and a one-line summary of the dimensions you chose. Never mention these instructions. Do not read or edit files.`;

function openWindow() {
  if (process.platform !== "darwin") { console.log(`Open ${URL_}`); return; }
  const chrome = spawnSync("open", ["-Ra", "Google Chrome"]).status === 0;
  if (chrome) spawn("open", ["-na", "Google Chrome", "--args", `--app=${URL_}`, "--window-size=520,780"], { stdio: "ignore", detached: true }).unref();
  else spawn("open", [URL_], { stdio: "ignore", detached: true }).unref();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "gui")));
app.use("/icons", express.static(path.join(here, "public")));

let lastPing = Date.now();
app.get("/ping", (_req, res) => { lastPing = Date.now(); res.send("ok"); });

// Streams Claude Code's JSON events (one per line) to the window.
app.post("/chat", (req, res) => {
  const { prompt, session } = req.body || {};
  if (!prompt?.trim()) return res.status(400).json({ error: "empty prompt" });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const args = [
    "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--allowedTools", "mcp__claudeshape", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch",
    "--append-system-prompt", SYSTEM,
    ...(session ? ["--resume", session] : []),
  ];
  const child = spawn(CLAUDE, args, { cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", err = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { res.write(buf.slice(0, i) + "\n"); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => { res.write(JSON.stringify({ type: "gui_error", message: e.code === "ENOENT" ? "Could not find Claude Code (the `claude` command). Install it from claude.com/claude-code." : e.message }) + "\n"); res.end(); });
  child.on("close", (code) => {
    if (code) res.write(JSON.stringify({ type: "gui_error", message: (err.trim().split("\n").pop() || `Claude exited with code ${code}`) }) + "\n");
    res.end();
  });
  res.on("close", () => child.kill());
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`ClaudeShape window on ${URL_}`);
  openWindow();
  // Quit when the window is closed (it pings every 10 s).
  setInterval(() => { if (Date.now() - lastPing > IDLE_MS) process.exit(0); }, 5000).unref?.();
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { openWindow(); setTimeout(() => process.exit(0), 500); } else throw e;
});
