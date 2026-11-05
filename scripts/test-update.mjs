import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { update } from "./update.mjs";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "upd-"));
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
const origin = path.join(T, "origin"), friend = path.join(T, "friend");
fs.mkdirSync(origin); sh("git init -q -b dev", origin);
const commit = (f, txt, msg) => { fs.writeFileSync(path.join(origin, f), txt); sh(`git add -A && git commit -qm ${msg}`, origin); };
commit("UPDATE_CHANNEL", "dev\n", "one"); commit("v.txt", "1", "v1");
sh(`git clone -q -b dev ${origin} ${friend}`);
const head = (d) => sh("git rev-parse --short HEAD", d), branch = (d) => sh("git rev-parse --abbrev-ref HEAD", d);

// 1. normal update
commit("v.txt", "2", "v2");
assert.equal(update(friend), "up to date"); assert.equal(head(friend), head(origin));
// 2. local edits don't block updating
fs.writeFileSync(path.join(friend, "v.txt"), "scribble");
commit("v.txt", "3", "v3");
assert.equal(update(friend), "up to date"); assert.equal(fs.readFileSync(path.join(friend, "v.txt"), "utf8"), "3");
// 3. diverged: dev copy left alone, friend install reset
fs.writeFileSync(path.join(friend, "mine.txt"), "x"); sh("git add -A && git commit -qm mine", friend);
commit("v.txt", "4", "v4");
assert.equal(update(friend), "diverged (left alone)");
fs.writeFileSync(path.join(friend, ".git", "claudeshape-managed"), "");
assert.equal(update(friend), "reset to latest"); assert.equal(head(friend), head(origin));
// 4. move everyone to another channel (e.g. main)
sh("git checkout -q -b main", origin); commit("v.txt", "5", "v5");
sh("git checkout -q dev", origin); commit("UPDATE_CHANNEL", "main\n", "move");
assert.equal(update(friend), "moved to main"); assert.equal(branch(friend), "main");
assert.equal(fs.readFileSync(path.join(friend, "v.txt"), "utf8"), "5");
// 5. offline never throws
fs.rmSync(origin, { recursive: true });
assert.equal(update(friend), "offline");
console.log("update tests passed");
