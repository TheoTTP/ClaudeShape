// Learns Onshape's own JSON for a sketch distance dimension by reading it out of a public example document.
// (Onshape documents no format for this; the only reliable source is a sketch that already has such a dimension.)
// The result is cached in ~/.claudeshape-learned.json and used by buildSketch; if nothing can be learned, sketches
// simply keep using the locked-anchor style that is already known to work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = () => path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".claudeshape-learned.json");
const VERSION = 1;
const DAY = 24 * 3600 * 1000;

export function loadLearned() {
  try { const j = JSON.parse(fs.readFileSync(file(), "utf8")); return j.version === VERSION && j.distance_pp ? j : null; } catch { return null; }
}
const loadState = () => { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return null; } };
export function saveLearned(obj) { try { fs.writeFileSync(file(), JSON.stringify({ version: VERSION, ...obj })); } catch {} }

const param = (c, id) => c.parameters?.find((p) => p.parameterId === id);

/** Pure: find a point-to-point horizontal/vertical DISTANCE dimension in a list of features. */
export function findSamples(features) {
  for (const f of features || []) {
    if (f.featureType !== "newSketch") continue;
    const ents = f.entities || [], pointIds = new Set();
    for (const e of ents) {
      if (String(e.btType || "").startsWith("BTMSketchPoint")) pointIds.add(e.entityId);
      for (const k of ["startPointId", "endPointId", "centerId"]) if (e[k]) pointIds.add(e[k]);
    }
    for (const c of f.constraints || []) {
      if (c.constraintType !== "DISTANCE") continue;
      const a = param(c, "localFirst")?.value, b = param(c, "localSecond")?.value;
      if (!pointIds.has(a) || !pointIds.has(b)) continue;              // both ends must be points in this sketch
      const dir = param(c, "direction");
      if (!dir || !/^(HORIZONTAL|VERTICAL)$/.test(dir.value)) continue;  // we need to say which axis
      if (!param(c, "length")) continue;
      return { distance_pp: JSON.parse(JSON.stringify(c)), point_entity: JSON.parse(JSON.stringify(ents.find((e) => String(e.btType || "").startsWith("BTMSketchPoint")) || null)) };
    }
  }
  return null;
}

/**
 * Search public documents for such a dimension. Never throws. Returns the learned object or null.
 * Skips the search if something was learned, or a search failed less than a day ago.
 */
export async function learn(osh, { maxMs = 90000, force = false, pauseMs = 300 } = {}) {
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : null);
  if (!force) {
    if (loadLearned()) return loadLearned();
    const st = loadState();
    if (st && st.version === VERSION && st.failedAt && Date.now() - st.failedAt < DAY) return null;
  }
  const t0 = Date.now();
  try {
    for (const q of ["sketch", "dimension", "bracket", "gear", "enclosure", "example"]) {
      let list;
      await pause();
      try { list = await osh.request("GET", `/api/documents?filter=4&q=${encodeURIComponent(q)}&limit=20`); } catch { continue; }
      for (const item of list.items || []) {
        if (Date.now() - t0 > maxMs) throw new Error("time budget");
        const did = item.id, wid = item.defaultWorkspace?.id;
        if (!did || !wid) continue;
        await pause();
        try {
          const els = await osh.request("GET", `/api/documents/d/${did}/w/${wid}/elements?elementType=PARTSTUDIO`);
          for (const el of (Array.isArray(els) ? els : []).slice(0, 3)) {
            await pause();
            const feats = await osh.request("GET", `/api/partstudios/d/${did}/w/${wid}/e/${el.id}/features`);
            const found = findSamples(feats.features);
            if (found) { const out = { ...found, learnedAt: Date.now(), source: `${did}/${el.id}` }; saveLearned(out); return loadLearned(); }
          }
        } catch { /* private or odd document: next */ }
      }
    }
  } catch { /* out of time */ }
  saveLearned({ failedAt: Date.now() });
  return null;
}


// ---------- learning how a loft's profile list is written ----------
const loftFile = () => path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".claudeshape-loft.json");
export const loadLoft = () => { try { const j = JSON.parse(fs.readFileSync(loftFile(), "utf8")); return j.array ? j : null; } catch { return null; } };
const loftState = () => { try { return JSON.parse(fs.readFileSync(loftFile(), "utf8")); } catch { return null; } };

/** Pure: find a loft feature with a list of profiles and return how that list is encoded. */
export function findLoftTemplate(features) {
  for (const f of features || []) {
    if (f.featureType !== "loft") continue;
    for (const p of f.parameters || []) {
      if (!String(p.btType || "").startsWith("BTMParameterArray") || !p.items?.length) continue;
      const item = p.items[0], inner = (item.parameters || []).find((q) => String(q.btType || "").includes("QueryList"));
      if (!inner) continue;
      return { array: { btType: p.btType, parameterId: p.parameterId }, item: { btType: item.btType }, inner: { parameterId: inner.parameterId, btType: inner.btType } };
    }
  }
  return null;
}

/** Search public documents for a loft and save how its profile list is written. Never throws. */
export async function learnLoft(osh, { maxMs = 90000, force = false, pauseMs = 300 } = {}) {
  if (!force) {
    if (loadLoft()) return loadLoft();
    const st = loftState();
    if (st?.failedAt && Date.now() - st.failedAt < DAY) return null;
  }
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : null);
  const t0 = Date.now();
  try {
    for (const q of ["loft", "bottle", "vase", "handle", "mouse", "example"]) {
      let list; await pause();
      try { list = await osh.request("GET", `/api/documents?filter=4&q=${encodeURIComponent(q)}&limit=20`); } catch { continue; }
      for (const item of list.items || []) {
        if (Date.now() - t0 > maxMs) throw new Error("time budget");
        const did = item.id, wid = item.defaultWorkspace?.id;
        if (!did || !wid) continue;
        await pause();
        try {
          const els = await osh.request("GET", `/api/documents/d/${did}/w/${wid}/elements?elementType=PARTSTUDIO`);
          for (const el of (Array.isArray(els) ? els : []).slice(0, 3)) {
            await pause();
            const feats = await osh.request("GET", `/api/partstudios/d/${did}/w/${wid}/e/${el.id}/features`);
            const t = findLoftTemplate(feats.features);
            if (t) { fs.writeFileSync(loftFile(), JSON.stringify({ ...t, learnedAt: Date.now(), source: `${did}/${el.id}` })); return loadLoft(); }
          }
        } catch { /* private or odd document: next */ }
      }
    }
  } catch { /* out of time */ }
  try { fs.writeFileSync(loftFile(), JSON.stringify({ failedAt: Date.now() })); } catch {}
  return null;
}
