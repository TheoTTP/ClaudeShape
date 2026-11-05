// Finds out, by measuring, how this Onshape wants a partial revolve angle written (it has been ignoring ours and making
// full rings). A tiny test circle is revolved 90 degrees in a scratch document in each candidate style; the style whose
// result is a quarter turn (not a full ring) is remembered in ~/.claudeshape-revolve.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSketch, buildRevolve, buildExtrude, REVOLVE_VARIANTS, setRevolveVariant, setRegionPoint } from "./onshape.js";
import { createDocumentWithStudio } from "./doc.js";

const file = () => path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".claudeshape-revolve.json");
const DAY = 24 * 3600 * 1000;
export const loadRevolveCal = () => { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return null; } };
const save = (o) => { try { fs.writeFileSync(file(), JSON.stringify(o, null, 1)); } catch {} };
/** Apply what was learned (call on start-up and before each tool call). */
export function applyRevolveCal() { const c = loadRevolveCal(); if (c?.variant) setRevolveVariant(c.variant, c.flip); return c; }

/**
 * @returns {Promise<{variant:string, flip:boolean}|null>} null if no style produced a quarter turn.
 * A 5 mm circle 45 mm from the axis, turned 90 degrees, spans about 55 mm in z; a full ring spans about 110 mm.
 */
export async function calibrateRevolve(osh, { force = false } = {}) {
  const have = loadRevolveCal();
  if (!force && have?.variant) return have;
  if (!force && have?.failedAt && Date.now() - have.failedAt < DAY) return null;
  const tried = [];
  try {
    const ctx = await createDocumentWithStudio(osh, "ClaudeShape setup (delete me)");
    const sk = buildSketch({ plane: "top", shapes: [{ type: "circle", cx: 0, cy: 0, r: 5 }, { type: "line", x1: 50, y1: -40, x2: 50, y2: 40, construction: true, id: "axis" }] });
    const { _label, _alts, _verify, ...plain } = sk;
    const sketch = await osh.addFeature(ctx, { ...plain, name: "Calibration sketch", constraints: [] });
    const sketchId = sketch.feature?.featureId;
    if (!sketchId) throw new Error("could not create the test sketch");
    for (const id of Object.keys(REVOLVE_VARIANTS)) {
      setRevolveVariant(id);
      let fid, zr = null, up = null, status;
      try {
        const r = await osh.addFeature(ctx, buildRevolve({ name: `Test ${id}`, sketch_id: sketchId, axis_entity_id: "axis", angle: 90, operation: "new" }));
        fid = r.feature?.featureId; status = r.featureState?.featureStatus;
        if (status !== "ERROR") {
          const b = await osh.getBoundingBox(ctx);
          zr = (b.highZ - b.lowZ) * 1000; up = Math.abs(b.highZ) >= Math.abs(b.lowZ);
        }
      } catch (e) { status = String(e.message).slice(0, 80); }
      tried.push({ id, status, zrange_mm: zr === null ? null : +zr.toFixed(1) });
      if (zr !== null && zr > 30 && zr < 80) {                       // a quarter turn, not a ring
        const out = { variant: id, flip: !up, calibratedAt: Date.now(), tried };
        save(out); setRevolveVariant(id, !up); return out;
      }
      if (fid) await osh.deleteFeature(ctx, fid).catch(() => {});
    }
  } catch (e) { tried.push({ error: String(e.message).slice(0, 200) }); }
  if (have?.variant) return have;
  setRevolveVariant("v1");
  save({ failedAt: Date.now(), tried });
  return null;
}

// ---- can one sketch serve many features, each picking its own region by a point? ----
const regionFile = () => path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".claudeshape-region.json");
export const loadRegionCal = () => { try { return JSON.parse(fs.readFileSync(regionFile(), "utf8")); } catch { return null; } };
export function applyRegionCal() { const c = loadRegionCal(); setRegionPoint(!!c?.ok); return c; }

/** Two separate rectangles in one Front-plane sketch; extrude only one, chosen by a point inside it. Success = only that one exists. */
export async function calibrateRegionPoint(osh, { force = false } = {}) {
  const have = loadRegionCal();
  if (!force && have && (have.ok || (have.failedAt && Date.now() - have.failedAt < DAY))) return have.ok ? have : null;
  const result = {};
  try {
    const ctx = await createDocumentWithStudio(osh, "ClaudeShape setup (delete me)");
    const sk = buildSketch({ plane: "front", shapes: [{ type: "rectangle", x: 10, y: 10, width: 10, height: 10 }, { type: "rectangle", x: 40, y: 10, width: 10, height: 10 }] });
    const { _label, _alts, _verify, ...plain } = sk;
    const sketch = await osh.addFeature(ctx, { ...plain, name: "Region test sketch", constraints: [] });
    const sid = sketch.feature?.featureId;
    if (!sid) throw new Error("could not create the test sketch");
    const r = await osh.addFeature(ctx, buildExtrude({ name: "Region test", sketch_id: sid, region_point: [15, 0, 15], depth: 5, direction: "symmetric", operation: "new" }));
    result.status = r.featureState?.featureStatus;
    if (result.status !== "ERROR") {
      const b = await osh.getBoundingBox(ctx);
      result.x_mm = [+(b.lowX * 1000).toFixed(1), +(b.highX * 1000).toFixed(1)];
      // only the left rectangle (x 10..20) was extruded: a 10 mm wide body at x 10..20
      if (Math.abs(b.lowX * 1000 - 10) < 1.5 && Math.abs(b.highX * 1000 - 20) < 1.5) { const out = { ok: true, calibratedAt: Date.now(), ...result }; fs.writeFileSync(regionFile(), JSON.stringify(out)); setRegionPoint(true); return out; }
    }
  } catch (e) { result.error = String(e.message).slice(0, 200); }
  if (have?.ok) return have;
  fs.writeFileSync(regionFile(), JSON.stringify({ ok: false, failedAt: Date.now(), ...result }));
  setRegionPoint(false);
  return null;
}
