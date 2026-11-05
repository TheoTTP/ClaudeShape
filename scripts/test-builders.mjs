import assert from "node:assert/strict";
import { buildSketch, buildRevolve, buildLinearPattern, buildCircularPattern, helperAxisPlan, planarFaces, planeQuery } from "../lib/onshape.js";

// endpoints of every segment, in metres
function ends(e) {
  const g = e.geometry;
  if (g.btType.includes("Line")) return [[g.pntX + g.dirX * e.startParam, g.pntY + g.dirY * e.startParam], [g.pntX + g.dirX * e.endParam, g.pntY + g.dirY * e.endParam]];
  const at = (t) => [g.xCenter + g.radius * Math.cos(t), g.yCenter + g.radius * Math.sin(t)];
  return [at(e.startParam), at(e.endParam)];
}
function assertClosed(entities) {
  const pts = entities.flatMap(ends);
  for (const p of pts) {
    const m = pts.filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9).length;
    assert.equal(m % 2, 0, `dangling endpoint ${p}`);
  }
}

// rounded rectangle 40x20 r=5 via path (CCW, small arcs)
const R = 5;
const rr = buildSketch({ plane: "top", shapes: [{ type: "path", close: true, start: [R, 0], segments: [
  { to: [40 - R, 0] }, { to: [40, R], radius: R },
  { to: [40, 20 - R] }, { to: [40 - R, 20], radius: R },
  { to: [R, 20] }, { to: [0, 20 - R], radius: R },
  { to: [0, R] }, { to: [R, 0], radius: R },
] }] });
assert.equal(rr.entities.length, 8);
assertClosed(rr.entities);

// same shape travelled clockwise
const cw = buildSketch({ plane: "top", shapes: [{ type: "path", start: [R, 0], segments: [
  { to: [0, R], radius: R, clockwise: true }, { to: [0, 20 - R] }, { to: [R, 20], radius: R, clockwise: true },
  { to: [40 - R, 20] }, { to: [40, 20 - R], radius: R, clockwise: true }, { to: [40, R] },
  { to: [40 - R, 0], radius: R, clockwise: true }, { to: [R, 0] },
] }] });
assertClosed(cw.entities);
// the arc centres must be the corner centres, not mirrored
const centres = cw.entities.filter((e) => e.geometry.radius).map((e) => [e.geometry.xCenter * 1000, e.geometry.yCenter * 1000].map((v) => +v.toFixed(6)));
assert.deepEqual(centres.sort(), [[5, 5], [5, 15], [35, 5], [35, 15]].sort());

// slot, arc, large-arc D shape
assertClosed(buildSketch({ plane: "top", shapes: [{ type: "slot", length: 30, width: 8, angle_deg: 30 }] }).entities);
assertClosed(buildSketch({ plane: "top", shapes: [{ type: "path", close: true, start: [-10, 0], segments: [{ to: [10, 0], radius: 10, large: false }] }] }).entities);
const arcOnly = buildSketch({ plane: "top", shapes: [{ type: "arc", r: 10, start_deg: 300, end_deg: 60 }] }).entities[0];
assert.ok(arcOnly.endParam > arcOnly.startParam);

// revolve axis sketch: construction line keeps its id and flag
const rs = buildSketch({ plane: "front", shapes: [{ type: "rectangle", x: 5, width: 10, height: 20 }, { type: "line", x1: 0, y1: 0, x2: 0, y2: 30, construction: true, id: "axis" }] });
const ax = rs.entities.find((e) => e.entityId === "axis");
assert.equal(ax.isConstruction, true);
assert.throws(() => buildSketch({ plane: "top", shapes: [{ type: "line", x1: 0, y1: 0, x2: 1, y2: 1, id: "a" }, { type: "line", x1: 0, y1: 0, x2: 1, y2: 1, id: "a" }] }), /Duplicate/);
const rev = buildRevolve({ sketch_id: "S1", axis_entity_id: "axis", angle: 90 });
assert.ok(rev.parameters.find((p) => p.parameterId === "angle").expression === "90 deg");
assert.ok(rev.parameters.find((p) => p.parameterId === "axis").queries[0].queryString.includes('sketchEntityQuery(makeId("S1")'));
assert.equal(buildRevolve({ sketch_id: "S1", axis_entity_id: "axis" }).parameters.find((p) => p.parameterId === "revolveType").value, "FULL");

// patterns
const lp = buildLinearPattern({ feature_id: "F1", kind: "feature", helper_sketch_id: "S", helper_entity_id: "axis", spacing: 12, count: 4 });
assert.ok(lp.parameters.some((p) => p.btType.startsWith("BTMParameterFeatureList")));
assert.equal(lp.parameters.find((p) => p.parameterId === "instanceCount").expression, "4");
const cp = buildCircularPattern({ feature_id: "F1", helper_sketch_id: "S", helper_entity_id: "axis", count: 6 });
assert.equal(cp.parameters.find((p) => p.parameterId === "equalSpace").value, true);
assert.throws(() => buildLinearPattern({ feature_id: "F", helper_sketch_id: "S", helper_entity_id: "a", spacing: 1, count: 1 }));
assert.deepEqual(helperAxisPlan("z", [10, 20]), { base: "front", offset: -20, line: { x1: 10, y1: 0, x2: 10, y2: 50 } });

// faces
assert.deepEqual(planeQuery("face:JHD").deterministicIds, ["JHD"]);
const faces = planarFaces({ bodies: [{ id: "B", faces: [{ id: "F1", surface: { type: "plane", origin: [0, 0, 0.01], normal: [0, 0, 1] } }, { id: "F2", surface: { type: "cylinder" } }] }] });
assert.deepEqual(faces, [{ face_id: "F1", body_id: "B", normal: [0, 0, 1], origin_mm: [0, 0, 10] }]);
console.log("builder tests passed");
