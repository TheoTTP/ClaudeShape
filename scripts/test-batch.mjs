import assert from "node:assert/strict";
import { runTool } from "../lib/agent.js";
import { buildShell } from "../lib/onshape.js";

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
  assert.ok(!("_label" in f), "internal fields are never sent to Onshape");
  const count = (t) => f.constraints.filter((c) => c.constraintType === t).length;
  // rectangle: 4 joints, 2 horizontal, 2 vertical, width+height, 1 anchor; circle: anchored centre + radius
  assert.deepEqual([count("COINCIDENT"), count("HORIZONTAL"), count("VERTICAL"), count("LENGTH"), count("FIX"), count("RADIUS")], [4, 2, 2, 2, 2, 1]);
  assert.equal(new Set(f.constraints.map((c) => c.entityId)).size, f.constraints.length);
  const len = f.constraints.filter((c) => c.constraintType === "LENGTH").map((c) => c.parameters[1].expression);
  assert.deepEqual(len, ["10 mm", "20 mm"]);
  assert.equal(f.constraints.find((c) => c.constraintType === "RADIUS").parameters[1].expression, "2 mm");

  // every shape is fully constrained (only joint / anchor / dimension constraints; entity-locking was shown NOT to define a sketch)
  const cons = async (shapes) => { calls.length = 0; await runTool(ok, {}, "create_sketch", { plane: "top", shapes }); const c = {}; calls[0].constraints.forEach((x) => (c[x.constraintType] = (c[x.constraintType] || 0) + 1)); return c; };
  assert.deepEqual(await cons([{ type: "polygon", points: [[0, 0], [5, 0], [0, 5]] }]), { COINCIDENT: 3, FIX: 3 });          // 3 joints, 3 anchored corners
  assert.deepEqual(await cons([{ type: "regular_polygon", sides: 6, r: 10 }]), { COINCIDENT: 6, FIX: 6 });
  assert.deepEqual(await cons([{ type: "slot", length: 18, width: 9 }]), { COINCIDENT: 4, FIX: 4, RADIUS: 2 });              // 2 lines + 2 arcs
  assert.deepEqual(await cons([{ type: "arc", r: 10, start_deg: 0, end_deg: 90 }]), { FIX: 2, RADIUS: 1 });
  assert.deepEqual(await cons([{ type: "line", x1: 0, y1: 0, x2: 0, y2: 30, construction: true, id: "axis" }]), { FIX: 2 });
  const round4 = [{ type: "path", close: true, start: [5, 0], segments: [{ to: [35, 0] }, { to: [40, 5], radius: 5 }, { to: [40, 15] }, { to: [35, 20], radius: 5 }, { to: [5, 20] }, { to: [0, 15], radius: 5 }, { to: [0, 5] }, { to: [5, 0], radius: 5 }] }];
  assert.deepEqual(await cons(round4), { COINCIDENT: 8, FIX: 8, RADIUS: 4 });                                                  // rounded rectangle
  assert.deepEqual(await cons([{ type: "path", start: [0, 0], segments: [{ to: [5, 0] }, { to: [8, 3], radius: 3 }] }]), { COINCIDENT: 1, FIX: 3, RADIUS: 1 });   // open chain
  // clockwise arcs join the right ends (traversal start = entity end)
  await cons([{ type: "path", start: [5, 0], segments: [{ to: [0, 5], radius: 5, clockwise: true }, { to: [0, 15] }, { to: [5, 20], radius: 5, clockwise: true }, { to: [35, 20] }, { to: [40, 15], radius: 5, clockwise: true }, { to: [40, 5] }, { to: [35, 0], radius: 5, clockwise: true }, { to: [5, 0] }] }]);
  const pairs = calls[0].constraints.filter((c) => c.constraintType === "COINCIDENT").map((c) => c.parameters.map((q) => q.value).sort().join("~"));
  assert.ok(pairs.includes("e0.start~e1.start"), "walk leaves the first (clockwise) arc through its entity START");
  assert.ok(pairs.includes("e0.end~e7.end"), "and enters it through its entity END");

  // if Onshape throws on the constraints -> the sketch is still created, plain
  calls.length = 0;
  const thr = { addFeature: async (_c, f) => { calls.push(f); if (f.constraints.length) throw new Error("400"); return respond("S2"); }, deleteFeature: async () => ({}) };
  const r2 = await runTool(thr, {}, "create_sketch", sk);
  assert.equal(calls.length, 2); assert.equal(calls[1].constraints.length, 0); assert.match(r2.defined, /^no/); assert.equal(r2.featureId, "S2");

  // accepted but ERROR -> bad sketch deleted, retried plain
  calls.length = 0; const deleted = [];
  const errs = { addFeature: async (_c, f) => { calls.push(f); const bad = f.constraints.length > 0; return respond(bad ? "BAD" : "GOOD", bad ? "ERROR" : "OK"); }, deleteFeature: async (_c, id) => { deleted.push(id); } };
  const r4 = await runTool(errs, {}, "create_sketch", sk);
  assert.deepEqual(deleted, ["BAD"]); assert.equal(r4.featureId, "GOOD"); assert.match(r4.defined, /^no/);

  // large sketches (> 600 entities) skip constraints so Onshape stays fast; normal text keeps them
  calls.length = 0;
  const txt = await runTool(ok, {}, "create_sketch", { plane: "top", shapes: [{ type: "text", text: "HELLO WORLD", height: 10 }] });
  assert.ok(calls[0].constraints.length > 0); assert.equal(txt.defined, "fully");
  calls.length = 0;
  const big = await runTool(ok, {}, "create_sketch", { plane: "top", shapes: [{ type: "text", text: "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN AND AGAIN", height: 10 }] });
  assert.equal(calls[0].constraints.length, 0); assert.match(big.defined, /too large/);
}
// Onshape accepts the request but keeps no constraints -> that sketch is deleted and re-added plain
{
  const calls = [], deleted = [];
  const os = { addFeature: async (_c, f) => { calls.push(f); const first = calls.length === 1; return { feature: { featureId: first ? "DROPPED" : "KEPT", constraints: first ? [] : f.constraints }, featureState: { featureStatus: "OK" } }; }, deleteFeature: async (_c, id) => { deleted.push(id); } };
  const r = await runTool(os, {}, "create_sketch", { plane: "top", shapes: [{ type: "rectangle", width: 10, height: 10 }] });
  assert.deepEqual(deleted, ["DROPPED"]); assert.equal(r.featureId, "KEPT"); assert.match(r.defined, /^no/);
  // and the build summary tells the user how the sketches came out
  calls.length = 0;
  const os2 = { addFeature: async (_c, f) => { calls.push(f); return { feature: { featureId: "S" + calls.length, constraints: f.constraints }, featureState: { featureStatus: "OK" } }; }, deleteFeature: async () => ({}), getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.01, highY: 0.01, highZ: 0.01 }) };
  const b = await runTool(os2, {}, "build_steps", { preview: false, steps: [{ tool: "box", input: { width: 10, depth: 10, height: 5 } }, { tool: "create_sketch", input: { plane: "top", shapes: [{ type: "polygon", points: [[0, 0], [5, 0], [0, 5]] }] } }] });
  assert.equal(b.sketches, "2 fully defined");   // (no editable-dimension note unless Onshape's dimension format has been learned)
}
// heavy sketch: POST says OK but it fails to solve -> deleted and re-added plain; a normal sketch costs no extra read
{
  const calls = [], deleted = []; let reads = 0;
  const os = {
    addFeature: async (_c, f) => { calls.push(f); return { feature: { featureId: "T" + calls.length, constraints: f.constraints }, featureState: { featureStatus: "OK" } }; },
    getFeatures: async () => { reads++; return { features: [], featureStates: { T1: { featureStatus: "ERROR" } } }; },
    deleteFeature: async (_c, id) => { deleted.push(id); },
  };
  const t = await runTool(os, {}, "create_sketch", { plane: "top", shapes: [{ type: "text", text: "HELLO", height: 10 }] });
  assert.deepEqual(deleted, ["T1"]); assert.equal(calls[1].constraints.length, 0); assert.match(t.defined, /^no/); assert.equal(reads, 1);
  reads = 0; calls.length = 0;
  await runTool(os, {}, "create_sketch", { plane: "top", shapes: [{ type: "rectangle", width: 5, height: 5 }] });
  assert.equal(reads, 0);
}
// build_steps reports features that Onshape shows in an error state
{
  const os = {
    addFeature: async (_c, f) => ({ feature: { featureId: f.featureType === "extrude" ? "X1" : "S1", name: f.name, constraints: f.constraints }, featureState: { featureStatus: "OK" } }),
    getFeatures: async () => ({ features: [{ featureId: "S1", name: "Sk" }, { featureId: "X1", name: "Ex" }, { featureId: "OTHER", name: "Old" }], featureStates: { S1: { featureStatus: "OK" }, X1: { featureStatus: "ERROR", statusMessage: "Sketch region missing" }, OTHER: { featureStatus: "ERROR" } } }),
    deleteFeature: async () => ({}), getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.01, highY: 0.01, highZ: 0.01 }),
  };
  const r = await runTool(os, {}, "build_steps", { preview: false, steps: [{ tool: "box", input: { width: 10, depth: 10, height: 5 } }] });
  assert.deepEqual(r.problems, [{ feature: "Ex", id: "X1", error: "Sketch region missing" }]);   // only features from this build
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

// ---- enclosure + cutout macros ----
{
  const posted = [];
  const os = {
    addFeature: async (_c, f) => { posted.push(f); return { feature: { featureId: "F" + posted.length }, featureState: { featureStatus: "OK" } }; },
    deleteFeature: async () => ({}),
    getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.17, highY: 0.1, highZ: 0.06 }),
  };
  const p = (f, id) => f.parameters.find((q) => q.parameterId === id);
  const rects = (f) => { const xs = f.entities.flatMap((e) => [e.geometry.pntX, e.geometry.pntX + e.geometry.dirX * e.endParam]).map((v) => Math.round(v * 10000) / 10); return [Math.min(...xs), Math.max(...xs)]; };

  const r = await runTool(os, {}, "build_steps", { preview: false, steps: [{ tool: "enclosure", as: "case", input: { width: 80, depth: 100, height: 50, round: 3, thumb_notch: true, lid: { gap: 10 } } }] });
  assert.equal(r.error, undefined);
  const names = posted.filter((f) => f.featureType !== "fillet").map((f) => f.name);
  assert.deepEqual(names, ["Case base walls sketch", "Case base", "Case base floor sketch", "Case base floor", "Case lid lip sketch", "Case lid lip",
    "Case lid plate sketch", "Case lid plate", "Case notch sketch", "Case finger notch"]);
  const sk = (n) => posted.find((f) => f.name === n);
  assert.deepEqual(rects(sk("Case base walls sketch")), [0, 80]);                  // base at x 0..80
  assert.deepEqual(rects(sk("Case lid plate sketch")), [90, 170]);                 // lid beside it: 80 + 10 gap .. 170
  const lip = sk("Case lid lip sketch"); assert.deepEqual(rects(lip), [92.8, 167.2]);   // inset by wall 2.5 + clearance 0.3
  assert.equal(p(posted.find((f) => f.name === "Case lid lip"), "depth").expression, "7 mm");   // plate 3 + lip 4
  assert.equal(p(posted.find((f) => f.name === "Case lid plate"), "operationType").value, "ADD");
  const notch = posted.find((f) => f.name === "Case finger notch");
  assert.equal(p(notch, "operationType").value, "REMOVE"); assert.equal(p(notch, "oppositeDirection").value, true);   // from the front plane into the wall
  assert.equal(p(notch, "depth").expression, "2.9 mm");
  assert.match(sk("Case notch sketch").parameters[0].queries[0].queryString, /"Front"/);
  assert.ok(posted.filter((f) => f.featureType === "fillet").length >= 2);          // base and lid corners rounded

  // cutouts: ports on the front, vents on the bottom; no extra planes
  posted.length = 0;
  await runTool(os, {}, "build_steps", { preview: false, steps: [
    { tool: "cutout", input: { face: "front", a: 10, b: 8, w: 15, h: 6, name: "USB port" } },
    { tool: "cutout", input: { face: "bottom", a: 20, b: 20, w: 30, h: 3, slot: true, repeat: { nb: 4, db: 6 }, name: "Vents" } },
    { tool: "cutout", input: { face: "left", a: 5, b: 5, w: 10, h: 4 } }] });
  assert.equal(posted.filter((f) => f.featureType === "cPlane").length, 0);
  const usb = posted.find((f) => f.name === "USB port"), vents = posted.find((f) => f.name === "Vents"), left = posted.filter((f) => f.featureType === "extrude").at(-1);
  assert.equal(p(usb, "oppositeDirection").value, true); assert.equal(p(usb, "depth").expression, "3 mm");
  assert.equal(p(vents, "oppositeDirection"), undefined); assert.equal(p(left, "oppositeDirection"), undefined);
  const ventSketch = posted.find((f) => f.name === "Vents sketch");
  assert.equal(ventSketch.entities.filter((e) => e.geometry.btType.includes("Line")).length, 8);    // 4 slots x 2 straight sides
  assert.match(posted.find((f) => f.name === "USB port sketch").parameters[0].queries[0].queryString, /"Front"/);
  assert.match(ventSketch.parameters[0].queries[0].queryString, /"Top"/);
  assert.match(posted.find((f) => f.name === "Cutout sketch").parameters[0].queries[0].queryString, /"Right"/);

  // guards
  assert.match((await runTool(os, {}, "build_steps", { preview: false, steps: [{ tool: "cutout", input: { face: "top", w: 1, h: 1 } }] })).error, /face must be/);
  assert.match((await runTool(os, {}, "build_steps", { preview: false, steps: [{ tool: "enclosure", input: { width: 11, depth: 11, height: 10, wall: 4 } }] })).error, /lid lip does not fit/);
}
console.log("enclosure tests passed");

// ---- shell / mirror / sweep / loft ----
{
  const posted = [];
  const os = {
    addFeature: async (_c, f) => { posted.push(f); return { feature: { featureId: "F" + posted.length }, featureState: { featureStatus: "OK" } }; },
    deleteFeature: async () => ({}),
    getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.04, highY: 0.04, highZ: 0.08 }),
  };
  const par = (f, id) => f.parameters.find((q) => q.parameterId === id);
  const qs = (f, id) => par(f, id).queries[0].queryString;

  await runTool(os, {}, "build_steps", { preview: false, steps: [
    { tool: "cylinder", as: "cup", input: { r: 20, height: 60 } },
    { tool: "shell", input: { feature_id: "$cup", thickness: 2.5 } },
    { tool: "mirror", input: { feature_id: "$cup", plane: "right" } },
  ] });
  const shell = posted.find((f) => f.featureType === "shell");
  assert.equal(par(shell, "thickness").expression, "2.5 mm");
  assert.match(qs(shell, "entities"), /qCapEntity\(makeId\("F2"\), CapType\.END, EntityType\.FACE\)/);           // top cap of the cylinder extrude
  const both = buildShellFor("both"); assert.match(both, /qUnion\(.*CapType\.END.*CapType\.START/);
  assert.match(buildShellFor("bottom"), /CapType\.START/);
  assert.throws(() => buildShellFor("side"), /open must be/);
  const mirror = posted.find((f) => f.featureType === "mirror");
  assert.equal(par(mirror, "mirrorType").value, "PART");
  assert.match(qs(mirror, "entities"), /qCreatedBy\(makeId\("F2"\), EntityType\.BODY\)/);
  assert.match(qs(mirror, "mirrorPlane"), /"Right"/);

  // sweep
  posted.length = 0;
  await runTool(os, {}, "sweep", { profile_sketch_id: "P1", path_sketch_id: "P2", operation: "add" });
  const sweep = posted[0];
  assert.equal(sweep.featureType, "sweep"); assert.equal(par(sweep, "operationType").value, "ADD");
  assert.match(qs(sweep, "profiles"), /qSketchRegion\(makeId\("P1"\), true\)/); assert.match(qs(sweep, "path"), /qCreatedBy\(makeId\("P2"\), EntityType\.EDGE\)/);

  // loft macro: planes at each height, one sketch per section, then the loft through them in order
  posted.length = 0;
  const lr = await runTool(os, {}, "build_steps", { preview: false, steps: [{ tool: "loft_sections", as: "vase", input: { name: "Vase", sections: [
    { z: 0, shapes: [{ type: "circle", r: 20 }] }, { z: 40, shapes: [{ type: "circle", r: 12 }] }, { z: 80, shapes: [{ type: "circle", r: 18 }] }] } }] });
  assert.equal(lr.error, undefined);
  assert.deepEqual(posted.map((f) => f.featureType), ["newSketch", "cPlane", "newSketch", "cPlane", "newSketch", "loft"]);     // no plane for z=0
  const loft = posted.at(-1), items = par(loft, "profileSubqueries").items;
  assert.equal(par(loft, "profileSubqueries").btType, "BTMParameterArray-2"); assert.equal(items.length, 3);
  assert.deepEqual(items.map((it) => it.parameters[0].queries[0].queryString.match(/makeId\("(F\d)"\)/)[1]), ["F1", "F3", "F5"]);   // the three sketches, bottom to top
  assert.match(posted[2].parameters[0].queries[0].queryString, /makeId\("F2"\)/);                                                    // section 2 sits on the offset plane
  assert.equal(par(posted[1], "offset").expression, "40 mm");
  assert.match((await runTool(os, {}, "build_steps", { steps: [{ tool: "loft_sections", input: { sections: [{ z: 0, shapes: [] }] } }] })).error, /at least 2 sections/);
  assert.match((await runTool(os, {}, "loft", { sketch_ids: ["A"] }).catch((e) => ({ error: e.message }))).error, /at least 2 sketch ids/);
}
function buildShellFor(open) { return buildShell({ feature_id: "F2", thickness: 2, open }).parameters.find((q) => q.parameterId === "entities").queries[0].queryString; }
console.log("feature tests passed");
