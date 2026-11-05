import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Onshape } from "./lib/onshape.js";
import { runAgent } from "./lib/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000, BASE_URL = `http://localhost:${PORT}`, SESSION_SECRET = "dev-secret-change-me",
  ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, ONSHAPE_ACCESS_KEY, ONSHAPE_SECRET_KEY,
  ONSHAPE_OAUTH_URL = "https://oauth.onshape.com",
} = process.env;

const useApiKeys = !!(ONSHAPE_ACCESS_KEY && ONSHAPE_SECRET_KEY);
const secure = BASE_URL.startsWith("https");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
// Onshape embeds the app in an iframe, so the cookie must be SameSite=None; Secure.
app.use(cookieSession({
  name: "claudeshape", keys: [SESSION_SECRET], maxAge: 8 * 3600 * 1000,
  sameSite: secure ? "none" : "lax", secure, httpOnly: true,
}));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://*.onshape.com");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const ctxFrom = (q) => ({ did: q.documentId, wid: q.workspaceId, eid: q.elementId });

// ---------- OAuth ----------
app.get("/oauth/login", (req, res) => {
  if (useApiKeys) return res.redirect("/");
  if (!ONSHAPE_CLIENT_ID) return res.status(500).send("ONSHAPE_CLIENT_ID is not configured");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;
  req.session.returnTo = req.query.returnTo || "/";
  const url = new URL(`${ONSHAPE_OAUTH_URL}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: ONSHAPE_CLIENT_ID, redirect_uri: `${BASE_URL}/oauth/callback`, state,
  });
  res.redirect(url.toString());
});

app.get("/oauth/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.state) throw new Error("Bad OAuth state");
    const r = await fetch(`${ONSHAPE_OAUTH_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: req.query.code, client_id: ONSHAPE_CLIENT_ID,
        client_secret: ONSHAPE_CLIENT_SECRET, redirect_uri: `${BASE_URL}/oauth/callback`,
      }),
    });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error_description || t.error || "token exchange failed");
    req.session.tok = { access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    res.redirect(req.session.returnTo || "/");
  } catch (e) {
    res.status(400).send(`Sign-in failed: ${e.message}`);
  }
});

async function bearer(req) {
  const t = req.session.tok;
  if (!t) return null;
  if (Date.now() < t.exp) return t.access;
  const r = await fetch(`${ONSHAPE_OAUTH_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: t.refresh, client_id: ONSHAPE_CLIENT_ID, client_secret: ONSHAPE_CLIENT_SECRET,
    }),
  });
  if (!r.ok) { req.session.tok = null; return null; }
  const n = await r.json();
  req.session.tok = { access: n.access_token, refresh: n.refresh_token || t.refresh, exp: Date.now() + (n.expires_in - 60) * 1000 };
  return n.access_token;
}

async function client(req) {
  if (useApiKeys) return new Onshape({ accessKey: ONSHAPE_ACCESS_KEY, secretKey: ONSHAPE_SECRET_KEY });
  const b = await bearer(req);
  return b ? new Onshape({ bearer: b }) : null;
}

const needAuth = async (req, res, next) => {
  req.os = await client(req);
  if (!req.os) return res.status(401).json({ error: "not_signed_in" });
  next();
};

// ---------- API ----------
app.get("/api/status", async (req, res) => {
  res.json({
    anthropic: !!process.env.ANTHROPIC_API_KEY, apiKeyMode: useApiKeys,
    signedIn: !!(await client(req)), context: ctxFrom(req.query),
  });
});

app.get("/api/features", needAuth, async (req, res) => {
  try { res.json(await req.os.getFeatures(ctxFrom(req.query))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Streams newline-delimited JSON events while Claude works.
app.post("/api/prompt", needAuth, async (req, res) => {
  const { prompt, documentId, workspaceId, elementId } = req.body || {};
  if (!prompt?.trim()) return res.status(400).json({ error: "empty prompt" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server" });
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: "Open ClaudeShape from inside a Part Studio tab (missing document context)." });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const emit = (ev) => res.write(JSON.stringify(ev) + "\n");
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    await runAgent({
      prompt, history: [], os: req.os, ctx: { did: documentId, wid: workspaceId, eid: elementId }, emit, signal: ac.signal,
    });
  } catch (e) {
    emit({ type: "error", message: e.message });
  }
  res.end();
});

app.listen(PORT, () => console.log(`ClaudeShape on ${BASE_URL} (${useApiKeys ? "API-key" : "OAuth"} mode)`));
