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

// ---- sketches are posted fully defined, with a safe fallback ----
{
  const calls = [];
  const sk = { plane: "top", shapes: [{ type: "rectangle", width: 10, height: 10 }, { type: "circle", r: 2, cx: 5, cy: 5 }] };
  const ok = { addFeature: async (_c, f) => { calls.push(f); return { feature: { featureId: "S1" }, featureState: { featureStatus: "OK" } }; }, deleteFeature: async () => ({}) };
  const r1 = await runTool(ok, {}, "create_sketch", sk);
  assert.equal(r1.defined, "fully");
  const f = calls[0];
  assert.equal(f.constraints.length, f.entities.length);                       // one FIX per entity (4 lines + circle)
  assert.equal(new Set(f.constraints.map((c) => c.entityId)).size, f.constraints.length);
  assert.ok(f.constraints.every((c) => c.constraintType === "FIX" && f.entities.some((e) => e.entityId === c.parameters[0].value)));

  // Onshape throws on constraints -> retried plain
  calls.length = 0;
  const throws = { addFeature: async (_c, f) => { calls.push(f); if (f.constraints.length) throw new Error("400"); return { feature: { featureId: "S2" }, featureState: { featureStatus: "OK" } }; }, deleteFeature: async () => ({}) };
  const r2 = await runTool(throws, {}, "create_sketch", sk);
  assert.equal(calls.length, 2); assert.equal(calls[1].constraints.length, 0); assert.match(r2.defined, /^no/); assert.equal(r2.featureId, "S2");

  // Onshape accepts but reports ERROR -> the bad sketch is deleted, then retried plain
  calls.length = 0; const deleted = [];
  const errs = { addFeature: async (_c, f) => { calls.push(f); const bad = f.constraints.length > 0; return { feature: { featureId: bad ? "BAD" : "S3" }, featureState: { featureStatus: bad ? "ERROR" : "OK" } }; }, deleteFeature: async (_c, id) => { deleted.push(id); } };
  const r3 = await runTool(errs, {}, "create_sketch", sk);
  assert.deepEqual(deleted, ["BAD"]); assert.equal(r3.featureId, "S3");
}
console.log("sketch-definition tests passed");
