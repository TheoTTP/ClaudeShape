// One-time setup: save Onshape API keys and register ClaudeShape with Claude Code.
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Onshape } from "../lib/onshape.js";
import { saveKeys, loadKeys, CONFIG_PATH } from "../lib/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

if (!loadKeys()) {
  console.log("\nOnshape needs one API key pair (this is the only thing you have to create):");
  console.log("  1. Open https://dev-portal.onshape.com/keys  and click \"Create new API key\"");
  console.log("  2. Tick Read + Write for documents, then copy the two values it shows you.\n");
  const accessKey = (await rl.question("Access key: ")).trim();
  const secretKey = (await rl.question("Secret key: ")).trim();
  try {
    const me = await new Onshape({ accessKey, secretKey }).whoami();
    console.log(`Connected to Onshape as ${me.name || me.email || "your account"}.`);
  } catch (e) { console.error("Those keys didn't work:", e.message); process.exit(1); }
  saveKeys({ accessKey, secretKey });
  console.log(`Saved to ${CONFIG_PATH}`);
} else console.log("Onshape keys already saved.");
rl.close();

const mcp = path.join(root, "mcp.js");
const r = spawnSync("claude", ["mcp", "add", "--scope", "user", "claudeshape", "--", process.execPath, mcp], { stdio: "inherit" });
if (r.error || r.status !== 0) {
  console.log(`\nAdd it to Claude manually:\n  claude mcp add --scope user claudeshape -- node ${mcp}`);
  console.log(`or for Claude Desktop add to claude_desktop_config.json:\n  "claudeshape": { "command": "node", "args": ["${mcp}"] }`);
} else console.log("\nDone. Restart Claude and say: \"Use ClaudeShape to make a 60x40x10 mm plate with four 5 mm holes.\"");
