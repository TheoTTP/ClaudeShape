// Document helpers shared by the MCP server and the desktop window.
// The window creates the Onshape document the moment you press send, in parallel with Claude thinking, and hands it
// to the MCP server through small files in the temp folder (the two run as separate processes).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASE = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";
export const urlOf = (c) => `${BASE}/documents/${c.did}/w/${c.wid}/e/${c.eid}`;

const T = () => process.env.CLAUDESHAPE_TMP || os.tmpdir();
const PENDING = () => path.join(T(), "claudeshape-pending.json");
const CREATING = () => path.join(T(), "claudeshape-creating");
const STATE = () => path.join(T(), "claudeshape-ctx.json");
const FRESH_MS = 15 * 60 * 1000;

const readJson = (f, maxAge) => {
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Date.now() - (j.t || 0) < maxAge ? j : null; } catch { return null; }
};
const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch {} };

export async function ensurePartStudio(osh, did, wid) {
  const find = async () => (await osh.getWorkspaceElements(did, wid)).find((e) => e.elementType === "PARTSTUDIO" || e.type === "Part Studio");
  let el = await find();
  if (!el) { await osh.createPartStudio(did, wid, "Part Studio 1"); el = await find(); }
  if (!el) throw new Error("Could not find or create a Part Studio");
  return el.id;
}

export async function createDocumentWithStudio(osh, name) {
  const d = await osh.createDocument(name);
  const wid = d.defaultWorkspace.id;
  return { did: d.id, wid, eid: await ensurePartStudio(osh, d.id, wid) };
}

// ---- hand-over of a pre-created document ----
export function clearAll() { rm(PENDING()); rm(CREATING()); rm(STATE()); }

/** Window side: create a blank document now so it is ready when Claude asks for one. Never throws. */
export async function precreate(osh) {
  try {
    fs.writeFileSync(CREATING(), String(Date.now()));
    const ctx = await createDocumentWithStudio(osh, "ClaudeShape part");
    fs.writeFileSync(PENDING(), JSON.stringify({ ...ctx, t: Date.now() }));
  } catch { /* the MCP server will just create one itself */ }
  finally { rm(CREATING()); }
}

/** MCP side: take the pre-created document (waiting briefly if it is still being made), or null. */
export async function takePending(maxWaitMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const p = readJson(PENDING(), FRESH_MS);
    if (p) { rm(PENDING()); return { did: p.did, wid: p.wid, eid: p.eid }; }
    const making = readJson(CREATING() + "", FRESH_MS) || (fs.existsSync(CREATING()) && Date.now() - fs.statSync(CREATING()).mtimeMs < FRESH_MS);
    if (!making || Date.now() - t0 > maxWaitMs) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

// ---- current document, shared between Claude processes (fast/review workers) ----
export function saveCtx(ctx) { try { fs.writeFileSync(STATE(), JSON.stringify({ ...ctx, t: Date.now() })); } catch {} }
export function clearCtx() { rm(STATE()); }
export function loadCtx() { const j = readJson(STATE(), 12 * 3600 * 1000); return j ? { did: j.did, wid: j.wid, eid: j.eid } : null; }
