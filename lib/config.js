import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_PATH = path.join(os.homedir(), ".claudeshape.json");

/** Onshape API keys from env or ~/.claudeshape.json */
export function loadKeys() {
  if (process.env.ONSHAPE_ACCESS_KEY && process.env.ONSHAPE_SECRET_KEY) {
    return { accessKey: process.env.ONSHAPE_ACCESS_KEY, secretKey: process.env.ONSHAPE_SECRET_KEY };
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (c.accessKey && c.secretKey) return c;
  } catch {}
  return null;
}

export function saveKeys(k) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(k), { mode: 0o600 });
}
