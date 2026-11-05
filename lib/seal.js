import crypto from "node:crypto";

// Stateless encrypted tokens (AES-256-GCM) so the server needs no session store or cookies.
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: sign-ins will reset when the server restarts.");
const key = crypto.createHash("sha256").update(secret).digest();

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function unseal(tok) {
  try {
    const b = Buffer.from(String(tok), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch { return null; }
}
