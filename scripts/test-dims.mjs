import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "dims-"));
const { findSamples, learn, loadLearned } = await import("../lib/learn.js");
const { buildSketch, setLearned, makeDistance } = await import("../lib/onshape.js");
const { runTool, entitiesMatch } = await import("../lib/agent.js");

// What a real Onshape DISTANCE dimension between two sketch points looks like (shape as seen in public documents).
const q = (id, value) => ({ btType: "BTMParameterString-149", parameterId: id, value });
const realDistance = (a, b, dir = "HORIZONTAL") => ({
  btType: "BTMSketchConstraint-2", constraintType: "DISTANCE", entityId: "dim1",
  parameters: [q("localFirst", a), q("localSecond", b),
    { btType: "BTMParameterEnum-145", parameterId: "direction", enumName: "DimensionDirection", value: dir },
    { btType: "BTMParameterEnum-145", parameterId: "halfSpaceFirst", enumName: "HalfSpace", value: "LEFT" },
    { btType: "BTMParameterQuantity-147", parameterId: "length", expression: "12 mm", value: 0.012, units: "meter", isInteger: false }],
});
const sketchWith = (constraints) => ({ featureType: "newSketch", entities: [{ btType: "BTMSketchPoint-158", entityId: "p1", x: 0, y: 0 }, { btType: "BTMSketchPoint-158", entityId: "p2", x: 0.012, y: 0 }], constraints });

// ---- 1. finding a usable dimension in someone's sketch ----
assert.equal(findSamples([sketchWith([realDistance("p1", "origin")])]), null, "distance to a non-sketch reference is not usable");
assert.equal(findSamples([sketchWith([{ ...realDistance("p1", "p2"), parameters: realDistance("p1", "p2").parameters.filter((p) => p.parameterId !== "direction") }])]), null, "needs a horizontal/vertical direction");
assert.equal(findSamples([{ featureType: "extrude" }]), null);
const found = findSamples([sketchWith([{ constraintType: "COINCIDENT", parameters: [] }, realDistance("p1", "p2", "VERTICAL")])]);
assert.equal(found.distance_pp.constraintType, "DISTANCE"); assert.equal(found.point_entity.btType, "BTMSketchPoint-158");

// ---- 2. learning from public documents (fake Onshape), then remembering ----
let calls = 0;
const fakeOsh = (docs) => ({ request: async (method, url) => {
  calls++;
  if (url.startsWith("/api/documents?")) return { items: docs };
  if (url.includes("/elements")) return [{ id: "E1" }];
  if (url.includes("/features")) return { features: [sketchWith([realDistance("p1", "p2")])] };
  throw new Error("unexpected " + url);
} });
assert.equal(await learn(fakeOsh([{ id: "D1" }]), { pauseMs: 0 }), null);                         // document has no default workspace: nothing found
assert.equal(loadLearned(), null);
calls = 0; assert.equal(await learn(fakeOsh([{ id: "D1", defaultWorkspace: { id: "W1" } }]), { pauseMs: 0 }), null); assert.equal(calls, 0, "a failed search is not repeated within a day");
const learned = await learn(fakeOsh([{ id: "D1", defaultWorkspace: { id: "W1" } }]), { force: true, pauseMs: 0 });
assert.equal(learned.distance_pp.constraintType, "DISTANCE"); assert.deepEqual(loadLearned().distance_pp, learned.distance_pp);
calls = 0; await learn(fakeOsh([]), { pauseMs: 0 }); assert.equal(calls, 0, "once learned, no more searching");

// ---- 3. our dimension from the learned format ----
const d = makeDistance(learned.distance_pp, "cs_origin", "e0.start", 25, "VERTICAL");
const get = (c, id) => c.parameters.find((p) => p.parameterId === id);
assert.equal(get(d, "localFirst").value, "cs_origin"); assert.equal(get(d, "localSecond").value, "e0.start");
assert.equal(get(d, "direction").value, "VERTICAL"); assert.equal(get(d, "length").expression, "25 mm");
assert.equal(get(d, "halfSpaceFirst").value, "LEFT");                              // everything else kept as Onshape wrote it
assert.equal(makeDistance({ ...learned.distance_pp, parameters: learned.distance_pp.parameters.filter((p) => p.parameterId !== "direction") }, "a", "b", 1, "HORIZONTAL"), null);

// ---- 4. sketches anchored with dimensions instead of locks ----
const count = (f) => { const c = {}; f.constraints.forEach((x) => (c[x.constraintType] = (c[x.constraintType] || 0) + 1)); return c; };
setLearned(learned);
const rect = buildSketch({ plane: "top", shapes: [{ type: "rectangle", x: 10, y: 20, width: 60, height: 40 }] });
assert.deepEqual(count(rect), { COINCIDENT: 4, HORIZONTAL: 2, VERTICAL: 2, LENGTH: 2, DISTANCE: 2, FIX: 1 });   // 1 FIX = the origin point itself
assert.ok(rect.entities.some((e) => e.entityId === "cs_origin")); assert.equal(rect._label, "dimensioned"); assert.equal(rect._alts.length, 2);
assert.deepEqual(rect.constraints.filter((c) => c.constraintType === "DISTANCE").map((c) => get(c, "direction").value), ["HORIZONTAL", "VERTICAL"]);
assert.equal(get(rect._alts[0].constraints.find((c) => c.constraintType === "DISTANCE"), "localFirst").value, "e0.start");   // flipped ends
assert.equal(rect._alts[1].entities.some((e) => e.entityId === "cs_origin"), false);                              // last resort: no origin point, anchors locked
assert.equal(rect._alts[1].constraints.filter((c) => c.constraintType === "FIX").length, 1);
const atOrigin = buildSketch({ plane: "top", shapes: [{ type: "rectangle", width: 60, height: 40 }] });
assert.deepEqual(count(atOrigin), { COINCIDENT: 5, HORIZONTAL: 2, VERTICAL: 2, LENGTH: 2, FIX: 1 });                // corner joined to the origin point
const onAxis = buildSketch({ plane: "top", shapes: [{ type: "rectangle", x: 0, y: 5, width: 60, height: 40 }] });
assert.equal(onAxis._label, "fully"); assert.equal(onAxis.entities.some((e) => e.entityId === "cs_origin"), false);   // one coordinate is 0: locked as before
const circle = buildSketch({ plane: "top", shapes: [{ type: "circle", cx: 30, cy: -20, r: 5 }] });
assert.deepEqual(count(circle), { DISTANCE: 2, RADIUS: 1, FIX: 1 });
assert.equal(get(circle.constraints.filter((c) => c.constraintType === "DISTANCE")[1], "length").expression, "20 mm");   // distances are positive: the geometry keeps the side
assert.equal(buildSketch({ plane: "top", shapes: [{ type: "polygon", points: [[0, 0], [5, 0], [0, 5]] }] })._label, "fully");   // shapes without a size recipe stay locked
setLearned(null);
assert.equal(buildSketch({ plane: "top", shapes: [{ type: "rectangle", x: 10, y: 20, width: 6, height: 4 }] })._label, "fully");   // nothing learned: old behaviour

// ---- 5. the solver check and the fallbacks ----
setLearned(learned);
const sk = { plane: "top", shapes: [{ type: "rectangle", x: 10, y: 20, width: 60, height: 40 }] };
const solverFake = (behaviour) => {            // behaviour(n) -> "keep" | "move" for the n-th sketch post
  const posted = [], deleted = []; let stored = {};
  return { posted, deleted,
    addFeature: async (_c, f) => { posted.push(f); const id = "S" + posted.length; stored[id] = { featureId: id, entities: JSON.parse(JSON.stringify(f.entities)) };
      if (behaviour(posted.length) === "move") stored[id].entities[0].geometry.pntX += 0.01;      // the solver dragged a line
      return { feature: { featureId: id, constraints: f.constraints }, featureState: { featureStatus: "OK" } }; },
    getFeatures: async () => ({ features: Object.values(stored), featureStates: {} }),
    deleteFeature: async (_c, id) => { deleted.push(id); delete stored[id]; } };
};
let o = solverFake(() => "keep");
let r = await runTool(o, {}, "create_sketch", sk);
assert.equal(r.defined, "dimensioned"); assert.equal(o.posted.length, 1);
for (const f of o.posted) assert.ok(!("_label" in f) && !("_alts" in f) && !("_verify" in f), "internal fields never sent");
o = solverFake((n) => (n === 1 ? "move" : "keep"));                                               // first reading is wrong, swapped ends fine
r = await runTool(o, {}, "create_sketch", sk);
assert.equal(r.defined, "dimensioned"); assert.deepEqual(o.deleted, ["S1"]); assert.equal(o.posted.length, 2);
o = solverFake((n) => (n <= 2 ? "move" : "keep"));                                                 // both wrong -> locked anchors
r = await runTool(o, {}, "create_sketch", sk);
assert.equal(r.defined, "fully"); assert.deepEqual(o.deleted, ["S1", "S2"]); assert.equal(o.posted.length, 3);
assert.equal(o.posted[2].entities.some((e) => e.entityId === "cs_origin"), false);
assert.ok(entitiesMatch(o.posted[2].entities, o.posted[2].entities));
assert.equal(entitiesMatch(o.posted[2].entities, []), false);
const bad = { addFeature: async () => ({ feature: { featureId: "X", constraints: [1] }, featureState: { featureStatus: "OK" } }), getFeatures: async () => { throw new Error("offline"); }, deleteFeature: async () => ({}) };
assert.equal((await runTool(bad, {}, "create_sketch", sk)).defined, "fully");                      // cannot verify -> do not trust the dimensions
setLearned(null);
console.log("dimension tests passed");
