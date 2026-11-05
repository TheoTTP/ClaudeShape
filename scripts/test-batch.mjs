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
