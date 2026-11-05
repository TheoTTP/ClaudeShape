// Self-update from GitHub. Runs on every launch; never blocks launching (offline is fine).
//  - follows the channel named in UPDATE_CHANNEL on the branch you're on (so everyone can be moved to e.g. `main`)
//  - friends' installs (marked by .git/claudeshape-managed) are hard-reset if history diverges; dev copies never are
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = (r) => r.status === 0;
const out = (r) => (r.stdout || "").trim();

export function update(root = defaultRoot) {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", timeout: 10000 });
  if (!fs.existsSync(path.join(root, ".git"))) return "not-a-git-checkout";
  const cur = out(git("rev-parse", "--abbrev-ref", "HEAD"));
  if (!cur || cur === "HEAD") return "detached";
  if (!ok(git("fetch", "-q", "origin", cur))) return "offline";
  let channel = cur;
  const want = git("show", `FETCH_HEAD:UPDATE_CHANNEL`);
  if (ok(want) && /^[\w./-]+$/.test(out(want))) channel = out(want);

  if (channel !== cur) {
    if (!ok(git("fetch", "-q", "origin", channel))) return "offline";
    git("stash", "-q");
    return ok(git("checkout", "-q", "-B", channel, "FETCH_HEAD")) ? `moved to ${channel}` : "channel-switch-failed";
  }
  git("stash", "-q");
  if (ok(git("merge", "-q", "--ff-only", "FETCH_HEAD"))) return "up to date";
  const managed = fs.existsSync(path.join(root, ".git", "claudeshape-managed"));
  if (managed && ok(git("reset", "-q", "--hard", "FETCH_HEAD"))) return "reset to latest";
  return "diverged (left alone)";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = update();
  // npm install only when dependencies changed (saves 1-3 s on every launch)
  const sig = (() => { try { return fs.readFileSync(path.join(defaultRoot, "package-lock.json"), "utf8").length + ":" + fs.statSync(path.join(defaultRoot, "package.json")).size; } catch { return ""; } })();
  const stamp = path.join(defaultRoot, "node_modules", ".claudeshape-deps");
  const had = (() => { try { return fs.readFileSync(stamp, "utf8"); } catch { return null; } })();
  if (had !== sig) {
    const n = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: defaultRoot, stdio: "ignore", shell: process.platform === "win32" });
    if (n.status === 0) { try { fs.writeFileSync(stamp, sig); } catch {} }
  }
  console.log("update:", r);
}
