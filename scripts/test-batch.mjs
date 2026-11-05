import assert from "node:assert/strict";
import { runTool } from "../lib/agent.js";

const posted = [];
const mkOs = (failAt) => ({
  addFeature: async (_c, f) => { posted.push(f); const n = posted.length; return { feature: { featureId: "F" + n, name: f.name }, featureState: { featureStatus: failAt === n ? "ERROR" : "OK", statusMessage: failAt === n ? "bad sketch" : undefined } }; },
  getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.06, highY: 0.04, highZ: 0.01 }),
  deleteFeature: async () => ({}),
});
const steps = [
  { tool: "create_sketch", as: "s", input: { plane: "top", shapes: [{ type: "rectangle", width: 60, height: 40 }] } },
  { tool: "extrude", as: "base", input: { sketch_id: "$s", depth: 10 } },
  { tool: "offset_plane", as: "pl", input: { from_plane: "top", offset: 10 } },
  { tool: "create_sketch", as: "s2", input: { plane: "feature:$pl", shapes: [{ type: "circle", r: 5 }] } },
  { tool: "extrude", input: { sketch_id: "$s2", depth: 3, operation: "add" } },
  { tool: "fillet", input: { feature_id: "$base", size: 1 } },
];
const r = await runTool(mkOs(), {}, "build_steps", { steps });
assert.equal(r.built.length, 6); assert.deepEqual(r.bounding_box.max_mm, [60, 40, 10]);
const q = (f, id) => f.parameters.find((p) => p.parameterId === id).queries[0];
assert.match(q(posted[1], "entities").queryString, /makeId\("F1"\)/);                 // $s -> F1
assert.match(q(posted[3], "sketchPlane").queryString, /makeId\("F3"\)/);               // feature:$pl -> F3
assert.match(q(posted[5], "entities").queryString, /makeId\("F2"\)/);                  // $base -> F2

// stops at the first failure and says where
posted.length = 0;
const bad = await runTool(mkOs(2), {}, "build_steps", { steps });
assert.equal(bad.stoppedAt, "base"); assert.equal(bad.error, "bad sketch"); assert.equal(posted.length, 2); assert.equal(bad.bounding_box, undefined);
// bad input is reported, not thrown
const bad2 = await runTool(mkOs(), {}, "build_steps", { steps: [{ tool: "create_sketch", input: { plane: "top", shapes: [{ type: "nope" }] } }] });
assert.match(bad2.error, /Unknown shape/);
assert.match((await runTool(mkOs(), {}, "build_steps", { steps: [{ tool: "list_features", input: {} }] })).error, /can't be used/);
console.log("batch tests passed");

// ---- sketches are posted fully defined, with safe fallbacks ----
{
  const calls = [];
  const sk = { plane: "top", shapes: [{ type: "rectangle", width: 10, height: 20 }, { type: "circle", r: 2, cx: 5, cy: 5 }] };
  const respond = (id, st = "OK") => ({ feature: { featureId: id }, featureState: { featureStatus: st } });
  const ok = { addFeature: async (_c, f) => { calls.push(f); return respond("S1"); }, deleteFeature: async () => ({}) };
  const r1 = await runTool(ok, {}, "create_sketch", sk);
  assert.equal(r1.defined, "fully");
  const f = calls[0];
  assert.ok(!("_fixOnly" in f), "internal fallback data is never sent to Onshape");
  const count = (t) => f.constraints.filter((c) => c.constraintType === t).length;
  // rectangle: 4 joints, 2 horizontal, 2 vertical, width+height, 1 anchor; circle: anchored centre + radius
  assert.deepEqual([count("COINCIDENT"), count("HORIZONTAL"), count("VERTICAL"), count("LENGTH"), count("FIX"), count("RADIUS")], [4, 2, 2, 2, 2, 1]);
  assert.equal(new Set(f.constraints.map((c) => c.entityId)).size, f.constraints.length);
  const len = f.constraints.filter((c) => c.constraintType === "LENGTH").map((c) => c.parameters[1].expression);
  assert.deepEqual(len, ["10 mm", "20 mm"]);
  assert.equal(f.constraints.find((c) => c.constraintType === "RADIUS").parameters[1].expression, "2 mm");

  // shapes without a parametric recipe (polygon) are locked entity by entity
  calls.length = 0;
  await runTool(ok, {}, "create_sketch", { plane: "top", shapes: [{ type: "polygon", points: [[0, 0], [5, 0], [0, 5]] }] });
  assert.equal(calls[0].constraints.length, 3); assert.ok(calls[0].constraints.every((c) => c.constraintType === "FIX"));

  // tier 1 throws -> tier 2 (everything locked) -> tier 3 (plain)
  calls.length = 0;
  const tiered = (failTiers) => ({ addFeature: async (_c, f) => { calls.push(f); const idx = calls.length - 1; if (idx < failTiers) throw new Error("400"); return respond("S" + calls.length); }, deleteFeature: async () => ({}) });
  const r2 = await runTool(tiered(1), {}, "create_sketch", sk);
  assert.equal(r2.defined, "locked"); assert.ok(calls[1].constraints.every((c) => c.constraintType === "FIX")); assert.equal(calls[1].constraints.length, calls[1].entities.length);
  calls.length = 0;
  const r3 = await runTool(tiered(2), {}, "create_sketch", sk);
  assert.match(r3.defined, /^no/); assert.equal(calls[2].constraints.length, 0);

  // accepted but ERROR -> bad sketch deleted, next tier tried
  calls.length = 0; const deleted = [];
  const errs = { addFeature: async (_c, f) => { calls.push(f); const bad = calls.length === 1; return respond(bad ? "BAD" : "GOOD", bad ? "ERROR" : "OK"); }, deleteFeature: async (_c, id) => { deleted.push(id); } };
  const r4 = await runTool(errs, {}, "create_sketch", sk);
  assert.deepEqual(deleted, ["BAD"]); assert.equal(r4.featureId, "GOOD"); assert.equal(r4.defined, "locked");

  // big sketches (e.g. text) skip constraints so Onshape stays fast
  calls.length = 0;
  const big = await runTool(ok, {}, "create_sketch", { plane: "top", shapes: [{ type: "text", text: "HELLO WORLD", height: 10 }] });
  assert.equal(calls[0].constraints.length, 0); assert.match(big.defined, /too large/);
}
console.log("sketch-definition tests passed");

// ---- extrude round + one-call builds ----
{
  const posted = [], deleted = [];
  let failFillets = 0;
  const os = {
    addFeature: async (_c, f) => { posted.push(f); const n = posted.length; const bad = f.featureType === "fillet" && failFillets-- > 0; return { feature: { featureId: "F" + n }, featureState: { featureStatus: bad ? "ERROR" : "OK" } }; },
    deleteFeature: async (_c, id) => { deleted.push(id); },
    getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.06, highY: 0.04, highZ: 0.01 }),
    getShadedView: async () => "QUJD",
  };
  const rect = { plane: "top", shapes: [{ type: "rectangle", width: 60, height: 40 }] };
  const r = await runTool(os, {}, "build_steps", { preview: true, steps: [
    { tool: "create_sketch", as: "s", input: rect }, { tool: "extrude", input: { sketch_id: "$s", depth: 10, round: { size: 3, edges: "vertical" } } }] });
  assert.equal(r._image.data, "QUJD"); assert.deepEqual(r.bounding_box.max_mm, [60, 40, 10]);
  assert.ok(r.built[1].rounded?.startsWith("3 mm vertical"));
  const fil = posted.find((f) => f.featureType === "fillet");
  assert.match(fil.parameters.find((p) => p.parameterId === "entities").queries[0].queryString, /qParallelEdges/);
  assert.equal(fil.parameters.find((p) => p.parameterId === "radius").expression, "3 mm");

  // fillet too big for Onshape -> retried at half size; if that fails too, skipped without failing the build
  posted.length = 0; failFillets = 1;
  const half = await runTool(os, {}, "extrude", { sketch_id: "S", depth: 5, round: { size: 4 } });
  assert.match(half.rounded, /^2 mm/); assert.equal(deleted.length, 1);
  posted.length = 0; failFillets = 5;
  const skip = await runTool(os, {}, "extrude", { sketch_id: "S", depth: 5, round: { size: 4 } });
  assert.match(skip.rounded, /^skipped/); assert.equal(skip.status, "OK");
  // cuts are never rounded
  posted.length = 0;
  await runTool(os, {}, "extrude", { sketch_id: "S", depth: 5, operation: "remove", round: { size: 4 } });
  assert.equal(posted.filter((f) => f.featureType === "fillet").length, 0);
}
console.log("round/preview tests passed");

// ---- macros ----
{
  const posted = [];
  const os = {
    addFeature: async (_c, f) => { posted.push(f); return { feature: { featureId: "F" + posted.length }, featureState: { featureStatus: "OK" } }; },
    deleteFeature: async () => ({}),
    getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.08, highY: 0.1, highZ: 0.05 }),
  };
  const types = () => posted.map((f) => f.featureType);

  // hollow box: walls sketch (outer+inner rect) -> extrude -> floor sketch -> extrude add; rounded vertical edges
  const r = await runTool(os, {}, "build_steps", { steps: [{ tool: "box", as: "b", input: { width: 80, depth: 100, height: 50, round: 4, hollow: { wall: 2.5 } } },
    { tool: "fillet", input: { feature_id: "$b", size: 1, edges: "horizontal" } }] });
  assert.equal(r.built.length, 2); assert.equal(r.built[0].featureIds.length, 4);       // sketch, extrude (+its fillet), sketch, extrude
  assert.deepEqual(types(), ["newSketch", "extrude", "fillet", "newSketch", "extrude", "fillet"]);
  assert.equal(posted[0].entities.filter((e) => e.geometry.btType.includes("Line")).length, 8);   // outer + inner rectangle
  const ex = (f, id) => f.parameters.find((p) => p.parameterId === id);
  assert.equal(ex(posted[1], "depth").expression, "50 mm"); assert.equal(ex(posted[4], "operationType").value, "ADD");
  assert.equal(ex(posted[4], "depth").expression, "2.5 mm");                                      // floor
  assert.match(posted[2].parameters.find((p) => p.parameterId === "entities").queries[0].queryString, /makeId\("F2"\)/);   // round hits the walls extrude
  assert.match(posted[5].parameters.find((p) => p.parameterId === "entities").queries[0].queryString, /makeId\("F2"\)/);   // $b = walls extrude
  assert.deepEqual(r.bounding_box.max_mm, [80, 100, 50]);

  // solid box + cylinder + holes grid
  posted.length = 0;
  await runTool(os, {}, "build_steps", { steps: [
    { tool: "box", input: { width: 60, depth: 40, height: 10, x: -30, y: -20, round: 2 } },
    { tool: "holes", input: { d: 5, grid: { nx: 2, ny: 2, dx: 50, dy: 30, x0: -25, y0: -15 }, depth: 20 } },
    { tool: "cylinder", input: { r: 10, height: 5, cx: 0, cy: 0, hollow: { wall: 2, floor: 1 } } }] });
  const holes = posted.find((f) => f.name === "Holes sketch");
  assert.equal(holes.entities.length, 4);
  const centres = holes.entities.map((e) => [e.geometry.xCenter * 1000, e.geometry.yCenter * 1000].map((v) => Math.round(v)));
  assert.deepEqual(centres.sort(), [[-25, -15], [-25, 15], [25, -15], [25, 15]].sort());
  assert.equal(ex(posted.find((f) => f.name === "Holes"), "operationType").value, "REMOVE");
  assert.equal(posted.filter((f) => f.name?.startsWith("Cylinder")).length, 4);                   // wall sketch, wall, floor sketch, floor

  // bad macro input is reported, not thrown; unknown macro-ish tools are rejected
  assert.match((await runTool(os, {}, "build_steps", { steps: [{ tool: "box", input: { width: 10, depth: 10, height: 5, hollow: { wall: 6 } } }] })).error, /too thick/);
  assert.match((await runTool(os, {}, "build_steps", { steps: [{ tool: "holes", input: { d: 5 } }] })).error, /holes needs/);
}
console.log("macro tests passed");

// ---- timing: every Onshape call is timed so we can see what is slow ----
{
  const { timedOs, takeTimings } = await import("../lib/agent.js");
  const base = { addFeature: async () => { await new Promise((r) => setTimeout(r, 30)); return { feature: { featureId: "F" }, featureState: { featureStatus: "OK" } }; }, getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.01, highY: 0.01, highZ: 0.01 }), deleteFeature: async () => ({}) };
  takeTimings();
  await runTool(timedOs(base), {}, "build_steps", { steps: [{ tool: "box", input: { width: 10, depth: 10, height: 5 } }] });
  const t = takeTimings();
  assert.deepEqual(t.map((x) => x.call), ["add newSketch", "add extrude", "getBoundingBox"]);
  assert.ok(t[0].ms >= 25); assert.deepEqual(takeTimings(), []);
}
console.log("timing tests passed");
