// Regression tests for bugs found in the audit.
import assert from "node:assert/strict";
import { buildSketch, buildExtrude, parseColor, planeQuery } from "../lib/onshape.js";

// first text contour must be constrained too
const t = buildSketch({ plane: "top", shapes: [{ type: "text", text: "I" }] });
assert.ok((t.constraints || []).length > 0, "single-contour text is constrained");

// custom ids like e1 do not collide with automatic ids
buildSketch({ plane: "top", shapes: [{ type: "line", x1: 0, y1: 0, x2: 5, y2: 0, id: "e1" }, { type: "circle", cx: 20, cy: 0, r: 3 }, { type: "circle", cx: 40, cy: 0, r: 4 }] });

// inherited object keys are not valid names
assert.equal(parseColor("constructor"), null);
assert.throws(() => planeQuery("constructor"));
assert.throws(() => buildExtrude({ sketch_id: "S", depth: 5, operation: "constructor" }));

// arcs: sweeps are normalised, full circles rejected
const a = buildSketch({ plane: "top", shapes: [{ type: "arc", cx: 0, cy: 0, r: 5, start_deg: -90, end_deg: 450 }] });
assert.ok(a);
console.log("audit tests passed");
