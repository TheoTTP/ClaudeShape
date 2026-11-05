import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Onshape } from "./lib/onshape.js";
import { runAgent } from "./lib/agent.js";
import { seal, unseal } from "./lib/seal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000, BASE_URL = `http://localhost:${PORT}`,
  ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, ONSHAPE_ACCESS_KEY, ONSHAPE_SECRET_KEY,
  ONSHAPE_OAUTH_URL = "https://oauth.onshape.com",
} = process.env;
const useApiKeys = !!(ONSHAPE_ACCESS_KEY && ONSHAPE_SECRET_KEY);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://*.onshape.com");
  res.setHeader("Access-Control-Expose-Headers", "x-refreshed-token");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok"));

const ctxFrom = (q) => ({ did: q.documentId, wid: q.workspaceId, eid: q.elementId });
const page = (body) => `<!doctype html><meta charset=utf-8><body style="font:15px system-ui;padding:24px">${body}`;

// ---------- Onshape OAuth (popup + token handed to the panel with postMessage; no cookies) ----------
app.get("/oauth/login", (req, res) => {
  if (!ONSHAPE_CLIENT_ID) return res.status(500).send(page("ONSHAPE_CLIENT_ID is not configured on the server."));
  const url = new URL(`${ONSHAPE_OAUTH_URL}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: ONSHAPE_CLIENT_ID, redirect_uri: `${BASE_URL}/oauth/callback`,
    state: seal({ t: Date.now() }),
  });
  res.redirect(url.toString());
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const st = unseal(req.query.state);
    if (!st || Date.now() - st.t > 10 * 60 * 1000) throw new Error("Sign-in expired, please try again");
    const r = await fetch(`${ONSHAPE_OAUTH_URL}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: req.query.code, client_id: ONSHAPE_CLIENT_ID,
        client_secret: ONSHAPE_CLIENT_SECRET, redirect_uri: `${BASE_URL}/oauth/callback`,
      }),
    });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error_description || t.error || "token exchange failed");
    const token = seal({ a: t.access_token, r: t.refresh_token, e: Date.now() + (t.expires_in - 60) * 1000 });
    res.send(page(`Signed in to Onshape. You can close this window.
      <script>try{window.opener.postMessage({claudeshapeToken:${JSON.stringify(token)}},${JSON.stringify(BASE_URL)})}catch(e){};setTimeout(()=>window.close(),300)</script>`));
  } catch (e) {
    res.status(400).send(page(`Sign-in failed: ${String(e.message).replace(/</g, "&lt;")}`));
  }
});

// Returns an Onshape client for this request, refreshing the token if needed.
async function client(req, res) {
  if (useApiKeys) return new Onshape({ accessKey: ONSHAPE_ACCESS_KEY, secretKey: ONSHAPE_SECRET_KEY });
  const t = unseal(req.get("x-onshape-token"));
  if (!t) return null;
  if (Date.now() < t.e) return new Onshape({ bearer: t.a });
  const r = await fetch(`${ONSHAPE_OAUTH_URL}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.r, client_id: ONSHAPE_CLIENT_ID, client_secret: ONSHAPE_CLIENT_SECRET }),
  });
  if (!r.ok) return null;
  const n = await r.json();
  res.setHeader("x-refreshed-token", seal({ a: n.access_token, r: n.refresh_token || t.r, e: Date.now() + (n.expires_in - 60) * 1000 }));
  return new Onshape({ bearer: n.access_token });
}

const needAuth = async (req, res, next) => {
  req.os = await client(req, res);
  if (!req.os) return res.status(401).json({ error: "not_signed_in" });
  next();
};

app.get("/api/status", async (req, res) => {
  res.json({
    serverKey: !!process.env.ANTHROPIC_API_KEY, apiKeyMode: useApiKeys,
    oauthConfigured: !!ONSHAPE_CLIENT_ID, signedIn: !!(await client(req, res)), context: ctxFrom(req.query),
  });
});

// Streams newline-delimited JSON events while Claude works.
app.post("/api/prompt", needAuth, async (req, res) => {
  const { prompt, documentId, workspaceId, elementId } = req.body || {};
  const apiKey = req.get("x-anthropic-key") || process.env.ANTHROPIC_API_KEY;
  if (!prompt?.trim()) return res.status(400).json({ error: "empty prompt" });
  if (!apiKey) return res.status(400).json({ error: "Add your Anthropic API key in the panel settings first." });
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: "Open ClaudeShape from inside a Part Studio (missing document context)." });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const emit = (ev) => res.write(JSON.stringify(ev) + "\n");
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    await runAgent({ prompt, apiKey, os: req.os, ctx: { did: documentId, wid: workspaceId, eid: elementId }, emit, signal: ac.signal });
  } catch (e) {
    emit({ type: "error", message: e.status === 401 ? "Anthropic rejected that API key." : e.message });
  }
  res.end();
});

app.listen(PORT, () => console.log(`ClaudeShape panel on ${BASE_URL} (${useApiKeys ? "API-key" : "OAuth"} mode)`));
