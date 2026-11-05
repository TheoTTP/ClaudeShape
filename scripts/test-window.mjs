// The window opens exactly once, however the app is launched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "win-"));
const bin = path.join(T, "bin"); fs.mkdirSync(bin);
const log = path.join(T, "opens.log");
fs.writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });   // stands in for the browser launcher
const env = { ...process.env, HOME: T, TMPDIR: T, PATH: `${bin}:${process.env.PATH}`, CLAUDESHAPE_PORT: "4599" };
const start = () => spawn("node", ["gui.js"], { env, stdio: "ignore" });
const opens = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// two copies started at once (double launch) -> one window
const a = start(), b = start();
await wait(1500);
assert.equal(opens(), 1, "double launch opened " + opens() + " windows");

// launching again while a window is open (pinging) -> no new window, the extra process exits
await fetch("http://127.0.0.1:4599/ping");
fs.rmSync(path.join(T, "claudeshape-window.lock"), { force: true });          // even with the lock gone
const c = start(); const exited = new Promise((r) => c.on("exit", r));
await Promise.race([exited, wait(3000)]);
assert.equal(opens(), 1, "relaunch with an open window opened another");
assert.notEqual(c.exitCode, null, "second process should have exited");

[a, b, c].forEach((p) => p.kill());
console.log("window tests passed");
