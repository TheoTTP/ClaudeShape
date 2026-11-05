import { textContours } from "./text.js";
// Thin Onshape REST client + builders for Part Studio feature JSON.
// All Onshape lengths are in metres; helpers here accept millimetres.

const BASE = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";
const API_VERSION = process.env.ONSHAPE_API_VERSION || "v10";
const mm = (v) => v / 1000;
const S2 = Math.SQRT1_2;
const VIEWS = {
  iso: [S2, S2, 0, 0, -0.40825, 0.40825, 0.81650, 0, 0.57735, -0.57735, 0.57735, 0],
  top: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  front: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0],
  right: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0],
  back: [-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],
  bottom: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0],
};
export const VIEW_NAMES = Object.keys(VIEWS);
export { VIEWS };

export class Onshape {
  /** @param {{bearer?:string, accessKey?:string, secretKey?:string}} auth */
  constructor(auth) {
    this.auth = auth;
  }

  headers() {
    if (this.auth.bearer) return { Authorization: `Bearer ${this.auth.bearer}` };
    const b64 = Buffer.from(`${this.auth.accessKey}:${this.auth.secretKey}`).toString("base64");
    return { Authorization: `Basic ${b64}` };
  }

  async request(method, path, body) {
    // Onshape rejects unversioned feature POSTs ("Error processing json"); pin the REST API version.
    path = path.replace(/^\/api\/(?!v\d+\/)/, `/api/${API_VERSION}/`);
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...this.headers(),
        Accept: "application/json;charset=UTF-8; qs=0.09",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Onshape ${method} ${path} -> ${res.status}: ${json.message || text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  ps(ctx) { return `/api/partstudios/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`; }

  getFeatures(ctx) { return this.request("GET", `${this.ps(ctx)}/features`); }
  addFeature(ctx, feature) { return this.request("POST", `${this.ps(ctx)}/features`, { feature }); }
  updateFeature(ctx, id, feature) { return this.request("POST", `${this.ps(ctx)}/features/featureid/${encodeURIComponent(id)}`, { feature }); }
  deleteFeature(ctx, id) { return this.request("DELETE", `${this.ps(ctx)}/features/featureid/${encodeURIComponent(id)}`); }
  // Rendered picture of the part studio (base64 PNG). viewMatrix = 3x4 rows [right; up; -forward].
  async getShadedView(ctx, view = "iso", size = 480) {
    const vm = VIEWS[view];
    if (!vm) throw new Error(`view must be one of ${Object.keys(VIEWS).join(", ")}`);
    const r = await this.request("GET", `${this.ps(ctx)}/shadedviews?viewMatrix=${vm.join(",")}&outputHeight=${size}&outputWidth=${size}&pixelSize=0&edges=show&useAntiAliasing=true`);
    if (!r.images?.length) throw new Error("Onshape returned no image");
    return r.images[0];
  }
  getBoundingBox(ctx) { return this.request("GET", `${this.ps(ctx)}/boundingboxes`); }
  getBodyDetails(ctx) { return this.request("GET", `${this.ps(ctx)}/bodydetails`); }
  getElementMetadata(ctx) { return this.request("GET", `/api/metadata/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`); }
  getPartMetadata(ctx, partId) { return this.request("GET", `/api/metadata/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}/p/${encodeURIComponent(partId)}`); }
  updatePartMetadata(ctx, partId, properties) {
    return this.request("POST", `/api/metadata/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}/p/${encodeURIComponent(partId)}`, { jsonType: "metadata-part", partId, properties });
  }
  /** Run a FeatureScript function in the Part Studio and return the raw reply. */
  evalFeatureScript(ctx, script) { return this.request("POST", `${this.ps(ctx)}/featurescript`, { script, queries: [] }); }
  getParts(ctx) { return this.request("GET", `/api/parts/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`); }
  whoami() { return this.request("GET", "/api/users/sessioninfo"); }
  listDocuments(q) { return this.request("GET", `/api/documents?q=${encodeURIComponent(q || "")}&limit=20`); }
  getWorkspaceElements(did, wid) { return this.request("GET", `/api/documents/d/${did}/w/${wid}/elements`); }
  renameDocument(did, name) { return this.request("POST", `/api/documents/${did}`, { name }); }
  createDocument(name) { return this.request("POST", "/api/documents", { name, isPublic: false }); }
  createPartStudio(did, wid, name) { return this.request("POST", `/api/partstudios/d/${did}/w/${wid}`, { name }); }
}

// ---------- parameter helpers ----------
const qList = (id, queries) => ({ btType: "BTMParameterQueryList-148", parameterId: id, queries });
const enumP = (id, enumName, value) => ({ btType: "BTMParameterEnum-145", parameterId: id, enumName, value, namespace: "" });
const boolP = (id, value) => ({ btType: "BTMParameterBoolean-144", parameterId: id, value });
const lenP = (id, valueMm) => ({
  btType: "BTMParameterQuantity-147", parameterId: id, isInteger: false, value: 0, units: "",
  expression: `${valueMm} mm`,
});
const fsQuery = (statement) => ({
  btType: "BTMIndividualQuery-138", deterministicIds: [],
  queryString: `query=${statement};`,
});

export const STANDARD_PLANES = { top: "Top", front: "Front", right: "Right" };

export function planeQuery(plane) {
  if (plane.startsWith("feature:")) {
    return fsQuery(`qCreatedBy(makeId("${plane.slice(8)}"), EntityType.FACE)`);
  }
  if (plane.startsWith("face:")) {
    return { btType: "BTMIndividualQuery-138", queryString: "", deterministicIds: [plane.slice(5)] };
  }
  const name = STANDARD_PLANES[plane.toLowerCase()];
  if (!name) throw new Error(`Unknown plane "${plane}". Use top, front, right, "feature:<planeFeatureId>" or "face:<faceId>".`);
  return fsQuery(`qCreatedBy(makeId("${name}"), EntityType.FACE)`);
}

// ---------- sketch ----------
/**
 * shapes (all dimensions mm, angles degrees, arcs counter-clockwise):
 *  {type:"circle", cx, cy, r}
 *  {type:"rectangle", x, y, width, height}              lower-left corner
 *  {type:"polygon", points:[[x,y],...]}                 closed
 *  {type:"regular_polygon", cx, cy, r, sides, rotation_deg?}   r = circumradius
 *  {type:"slot", cx, cy, length, width, angle_deg?}
 *  {type:"text", text, x, y, height, bold?, align?}  real font outlines; (x,y)=baseline start, height=capital height mm
 *  {type:"arc", cx, cy, r, start_deg, end_deg}          open arc
 *  {type:"line", x1,y1,x2,y2, construction?, id?}       construction lines never form regions;
 *                                                       use them as revolve axes
 *  {type:"path", start:[x,y], segments:[{to:[x,y], radius?, clockwise?, large?}], close?}
 *       connected lines and arcs; a segment with `radius` is an arc of that radius.
 */
// ---- sketch constraints (parameter ids follow FeatureScript's skConstraint: localFirst/localSecond/length) ----
const strP = (id, value) => ({ btType: "BTMParameterString-149", parameterId: id, value });
let _k = 0;
const con = (constraintType, parameters) => ({ btType: "BTMSketchConstraint-2", constraintType, entityId: `k${++_k}`, parameters });
const coincident = (a, b) => con("COINCIDENT", [strP("localFirst", a), strP("localSecond", b)]);
const horizontal = (id) => con("HORIZONTAL", [strP("localFirst", id)]);
const vertical = (id) => con("VERTICAL", [strP("localFirst", id)]);
const lengthDim = (id, v) => con("LENGTH", [strP("localFirst", id), lenP("length", v)]);
const radiusDim = (id, v) => con("RADIUS", [strP("localFirst", id), lenP("length", v)]);
const fixPoint = (pt) => con("FIX", [strP("localFirst", pt)]);
// Onshape's own format for a point-to-point distance dimension, learned from a public example (see lib/learn.js).
let LEARNED = null;
export const setLearned = (l) => { LEARNED = l; };
/** Clone the learned DISTANCE constraint for points a and b. direction is HORIZONTAL or VERTICAL. Null if unusable. */
export function makeDistance(sample, a, b, valueMm, direction) {
  if (!sample) return null;
  const c = JSON.parse(JSON.stringify(sample));
  c.entityId = `k${++_k}`;
  let ok = { a: false, b: false, len: false, dir: false };
  c.parameters = (c.parameters || []).map((p) => {
    if (p.parameterId === "localFirst") { ok.a = true; return { ...p, value: a }; }
    if (p.parameterId === "localSecond") { ok.b = true; return { ...p, value: b }; }
    if (p.parameterId === "length") { ok.len = true; return lenP("length", valueMm); }
    if (p.parameterId === "direction") { ok.dir = true; return { ...p, value: direction }; }
    return p;
  });
  return ok.a && ok.b && ok.len && ok.dir ? c : null;
}
const MAX_CONSTRAINED = 600;   // text/huge sketches: skip constraints to keep Onshape's solver fast

// Lock every entity in place so the sketch is fully defined (black in Onshape, not "under defined" blue).
export function fixConstraints(entities) {
  return entities.map((e) => ({
    btType: "BTMSketchConstraint-2", constraintType: "FIX", entityId: `fix.${e.entityId}`,
    parameters: [{ btType: "BTMParameterString-149", value: e.entityId, parameterId: "localFirst" }],
  }));
}
const TAU = Math.PI * 2;
const norm = (a0, a1) => { while (a1 <= a0) a1 += TAU; return a1; };

export function buildSketch({ name, plane, shapes }) {
  const entities = [];
  // Three parallel constraint lists: P (anchors dimensioned from a sketch origin point), P2 (same, dimension ends
  // swapped, in case Onshape reads the side the other way) and Q (anchors locked in place; always works).
  const P = [], P2 = [], Q = [];
  const O = "cs_origin", sample = LEARNED?.distance_pp, dimsOK = !!sample;
  let usedDims = false;
  const both = (...cs) => { P.push(...cs); P2.push(...cs); Q.push(...cs); };
  const anchor = (pt, x, y) => {                      // pin a point `x,y` mm from the origin
    Q.push(fixPoint(pt));
    const ax = Math.abs(x) > 1e-9, ay = Math.abs(y) > 1e-9;
    if (dimsOK && !ax && !ay) { P.push(coincident(O, pt)); P2.push(coincident(O, pt)); usedDims = true; return; }
    if (dimsOK && ax && ay) {
      const d = [makeDistance(sample, O, pt, Math.abs(x), "HORIZONTAL"), makeDistance(sample, O, pt, Math.abs(y), "VERTICAL")];
      const e = [makeDistance(sample, pt, O, Math.abs(x), "HORIZONTAL"), makeDistance(sample, pt, O, Math.abs(y), "VERTICAL")];
      if (d.every(Boolean) && e.every(Boolean)) { P.push(...d); P2.push(...e); usedDims = true; return; }
    }
    P.push(fixPoint(pt)); P2.push(fixPoint(pt));       // on an axis, or no learned format: lock it
  };
  const handled = new Set();   // entity ids covered by `param`
  const used = new Set();
  let n = 0;
  const nextId = (want) => {
    let id = want || `e${n++}`;
    if (used.has(id)) throw new Error(`Duplicate sketch entity id "${id}"`);
    used.add(id);
    return id;
  };
  const line = (x1, y1, x2, y2, want, construction) => {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1e-9) throw new Error("Zero-length sketch edge");
    const id = nextId(want);
    entities.push({
      btType: "BTMSketchCurveSegment-155", entityId: id,
      startPointId: `${id}.start`, endPointId: `${id}.end`,
      startParam: 0, endParam: mm(len), isConstruction: !!construction,
      geometry: { btType: "BTCurveGeometryLine-117", pntX: mm(x1), pntY: mm(y1), dirX: dx / len, dirY: dy / len },
    });
    return { id, start: `${id}.start`, end: `${id}.end` };
  };
  // CCW arc from angle a0 to a1 (radians)
  const arc = (cx, cy, r, a0, a1, want, cw = false) => {
    const id = nextId(want);
    entities.push({
      btType: "BTMSketchCurveSegment-155", entityId: id,
      startPointId: `${id}.start`, endPointId: `${id}.end`, centerId: `${id}.center`,
      startParam: a0, endParam: norm(a0, a1),
      geometry: { btType: "BTCurveGeometryCircle-115", radius: mm(r), xCenter: mm(cx), yCenter: mm(cy), xDir: 1, yDir: 0, clockwise: false },
    });
    // `cw` = the outline is walked clockwise, so the entity's own start/end are swapped relative to the walk
    return { id, start: cw ? `${id}.end` : `${id}.start`, end: cw ? `${id}.start` : `${id}.end`, radius: r };
  };
  // Fully define a walked chain of lines/arcs using only constraint types Onshape is known to solve:
  // join every neighbouring pair of endpoints, anchor each segment's first point, dimension every arc's radius.
  const chain = (segs, closed) => {
    segs.forEach((g, i) => {
      if (i < segs.length - 1 || closed) both(coincident(g.end, segs[(i + 1) % segs.length].start));
      both(fixPoint(g.start));
      if (g.radius) both(radiusDim(g.id, g.radius));
      handled.add(g.id);
    });
    if (!closed) both(fixPoint(segs[segs.length - 1].end));
  };
  const loop = (pts, constrain = true) => {
    if (pts.length < 3) throw new Error("A polygon needs at least 3 points");
    const segs = pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return line(p[0], p[1], q[0], q[1]); });
    if (constrain) chain(segs, true);
  };

  for (const s of shapes) {
    switch (s.type) {
      case "circle": {
        if (!(s.r > 0)) throw new Error("circle needs r > 0");
        const id = nextId();
        entities.push({
          btType: "BTMSketchCurve-4", entityId: id, centerId: `${id}.center`,
          geometry: { btType: "BTCurveGeometryCircle-115", radius: mm(s.r), xCenter: mm(s.cx ?? 0), yCenter: mm(s.cy ?? 0), xDir: 1, yDir: 0, clockwise: false },
        });
        anchor(`${id}.center`, s.cx ?? 0, s.cy ?? 0); both(radiusDim(id, s.r));   // centre + radius = fully defined
        handled.add(id);
        break;
      }
      case "rectangle": {
        const x = s.x ?? 0, y = s.y ?? 0;
        if (!(s.width > 0 && s.height > 0)) throw new Error("rectangle needs width,height > 0");
        const first = n;
        loop([[x, y], [x + s.width, y], [x + s.width, y + s.height], [x, y + s.height]], false);
        const L = [0, 1, 2, 3].map((i) => `e${first + i}`);
        // 4 joints + horizontal/vertical + width/height + one anchored corner = fully defined
        both(
          coincident(`${L[0]}.end`, `${L[1]}.start`), coincident(`${L[1]}.end`, `${L[2]}.start`),
          coincident(`${L[2]}.end`, `${L[3]}.start`), coincident(`${L[3]}.end`, `${L[0]}.start`),
          horizontal(L[0]), vertical(L[1]), horizontal(L[2]), vertical(L[3]),
          lengthDim(L[0], s.width), lengthDim(L[1], s.height),
        );
        anchor(`${L[0]}.start`, x, y);
        L.forEach((id) => handled.add(id));
        break;
      }
      case "polygon": loop(s.points); break;
      case "regular_polygon": {
        const k = Math.round(s.sides);
        if (k < 3) throw new Error("regular_polygon needs sides >= 3");
        const rot = ((s.rotation_deg ?? 0) * Math.PI) / 180;
        loop([...Array(k)].map((_, i) => {
          const a = rot + (TAU * i) / k;
          return [(s.cx ?? 0) + s.r * Math.cos(a), (s.cy ?? 0) + s.r * Math.sin(a)];
        }));
        break;
      }
      case "slot": {
        const { length, width } = s;
        if (!(width > 0 && length > width)) throw new Error("slot needs length > width > 0");
        const ang = ((s.angle_deg ?? 0) * Math.PI) / 180;
        const r = width / 2, half = length / 2 - r;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const T = (x, y) => [(s.cx ?? 0) + x * c - y * sn, (s.cy ?? 0) + x * sn + y * c];
        chain([
          line(...T(-half, -r), ...T(half, -r)),
          arc(...T(half, 0), r, ang - Math.PI / 2, ang + Math.PI / 2),
          line(...T(half, r), ...T(-half, r)),
          arc(...T(-half, 0), r, ang + Math.PI / 2, ang + 1.5 * Math.PI),
        ], true);
        break;
      }
      case "text": {
        const { contours } = textContours({ text: s.text, x: s.x ?? 0, y: s.y ?? 0, height: s.height ?? 10, bold: s.bold, align: s.align });
        contours.forEach(loop);
        break;
      }
      case "arc": {
        if (!(s.r > 0)) throw new Error("arc needs r > 0");
        const d = Math.PI / 180;
        const a = arc(s.cx ?? 0, s.cy ?? 0, s.r, s.start_deg * d, s.end_deg * d);
        both(fixPoint(a.start), fixPoint(a.end), radiusDim(a.id, s.r));   // both ends anchored + radius
        handled.add(a.id);
        break;
      }
      case "line": {
        const l = line(s.x1, s.y1, s.x2, s.y2, s.id, s.construction);
        both(fixPoint(l.start), fixPoint(l.end));
        handled.add(l.id);
        break;
      }
      case "path": {
        let p = s.start;
        const first = p, segs = [];
        for (const seg of s.segments) {
          const q = seg.to;
          if (!seg.radius) { segs.push(line(p[0], p[1], q[0], q[1])); }
          else {
            const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy), r = seg.radius;
            if (d < 1e-9) throw new Error("path arc has identical endpoints");
            if (2 * r < d - 1e-9) throw new Error(`path arc radius ${r} too small for chord ${d.toFixed(3)}`);
            const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
            const nx = -dy / d, ny = dx / d;                 // left of travel direction
            const cw = !!seg.clockwise, large = !!seg.large;
            const side = (cw !== large) ? -1 : 1;            // small CCW / large CW -> centre on left
            const cx = (p[0] + q[0]) / 2 + side * nx * h, cy = (p[1] + q[1]) / 2 + side * ny * h;
            const ap = Math.atan2(p[1] - cy, p[0] - cx), aq = Math.atan2(q[1] - cy, q[0] - cx);
            segs.push(cw ? arc(cx, cy, r, aq, ap, undefined, true) : arc(cx, cy, r, ap, aq));
          }
          p = q;
        }
        if (s.close && (Math.abs(p[0] - first[0]) > 1e-9 || Math.abs(p[1] - first[1]) > 1e-9)) segs.push(line(p[0], p[1], first[0], first[1]));
        const lastEnd = segs.length && (s.close || (Math.abs(p[0] - first[0]) < 1e-9 && Math.abs(p[1] - first[1]) < 1e-9));
        if (segs.length) chain(segs, !!lastEnd);
        break;
      }
      default: throw new Error(`Unknown shape type "${s.type}"`);
    }
  }
  const big = entities.length > MAX_CONSTRAINED;
  const originEntity = { btType: LEARNED?.point_entity?.btType || "BTMSketchPoint-158", entityId: O, x: 0, y: 0, isConstruction: false };
  return {
    btType: "BTMSketch-151", featureType: "newSketch", name: name || "Sketch", suppressed: false,
    parameters: [qList("sketchPlane", [planeQuery(plane)])],
    entities: usedDims && !big ? [...entities, originEntity] : entities,
    constraints: big ? [] : usedDims ? [...P, fixPoint(O)] : Q,
    // internal (stripped before sending): how the caller should try alternatives if Onshape does not accept the first
    _label: usedDims && !big ? "dimensioned" : "fully",
    _verify: usedDims && !big,
    _alts: usedDims && !big ? [
      { label: "dimensioned", verify: true, entities: [...entities, originEntity], constraints: [...P2, fixPoint(O)] },
      { label: "fully", verify: false, entities, constraints: Q },
    ] : [],
  };
}

// ---------- extrude ----------
// Regions of a sketch. By default, "island" regions that sit inside a hole (the middle of an O,
// the disc inside a ring) are skipped, so nested shapes cut holes instead of filling them.
const sketchRegions = (id, includeIslands) =>
  fsQuery(`qSketchRegion(makeId("${id}"), ${includeIslands ? "false" : "true"})`);

export function buildExtrude({ name, sketch_id, include_islands = false, depth, operation = "NEW", direction = "normal", second_depth }) {
  const op = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" }[operation.toLowerCase()];
  if (!op) throw new Error('operation must be "new", "add", "remove" or "intersect"');
  const dir = direction.toLowerCase();
  const params = [
    enumP("bodyType", "ExtendedToolBodyType", "SOLID"),
    enumP("operationType", "NewBodyOperationType", op),
    qList("entities", [sketchRegions(sketch_id, include_islands)]),
    enumP("endBound", "BoundingType", dir === "symmetric" ? "SYMMETRIC" : "BLIND"),
    lenP("depth", depth),
  ];
  if (dir === "reverse") params.push(boolP("oppositeDirection", true));
  if (second_depth) {
    params.push(boolP("hasSecondDirection", true));
    params.push(enumP("secondDirectionBound", "SecondDirectionBoundingType", "BLIND"));
    params.push(lenP("secondDirectionDepth", second_depth));
  }
  return { btType: "BTMFeature-134", featureType: "extrude", name: name || "Extrude", suppressed: false, parameters: params };
}

// ---------- fillet / chamfer on all edges created by a feature ----------
export function buildEdgeFeature(kind, { name, feature_id, size, edges = "all" }) {
  const q = qCreatedByEdges(feature_id, edges);
  if (kind === "fillet") {
    return {
      btType: "BTMFeature-134", featureType: "fillet", name: name || "Fillet", suppressed: false,
      parameters: [
        enumP("filletType", "FilletType", "EDGE"),
        qList("entities", [q]),
        enumP("cornerType", "FilletCornerType", "ROUND"),
        boolP("tangentPropagation", true),
        lenP("radius", size),
      ],
    };
  }
  return {
    btType: "BTMFeature-134", featureType: "chamfer", name: name || "Chamfer", suppressed: false,
    parameters: [
      qList("entities", [q]),
      enumP("chamferType", "ChamferType", "EQUAL_OFFSETS"),
      lenP("width", size),
    ],
  };
}
// edges: "all" | "vertical" (parallel to Z) | "horizontal" (everything else)
function qCreatedByEdges(id, which = "all") {
  const all = `qCreatedBy(makeId("${id}"), EntityType.EDGE)`;
  const vertical = `qParallelEdges(${all}, vector(0, 0, 1))`;
  if (which === "vertical") return fsQuery(vertical);
  if (which === "horizontal") return fsQuery(`qSubtraction(${all}, ${vertical})`);
  if (which !== "all") throw new Error('edges must be "all", "vertical" or "horizontal"');
  return fsQuery(all);
}

// ---------- offset plane ----------
export function buildOffsetPlane({ name, from_plane, offset }) {
  return {
    btType: "BTMFeature-134", featureType: "cPlane", name: name || "Plane", suppressed: false,
    parameters: [
      qList("entities", [planeQuery(from_plane)]),
      enumP("cplaneType", "CPlaneType", "OFFSET"),
      lenP("offset", offset),
    ],
  };
}

// ---------- sketch-entity references (construction lines as axes) ----------
const sketchEdge = (sketchId, entityId) =>
  fsQuery(`sketchEntityQuery(makeId("${sketchId}"), EntityType.EDGE, "${entityId}")`);

// ---------- revolve ----------
export function buildRevolve({ name, sketch_id, include_islands = false, axis_entity_id, angle = 360, operation = "NEW" }) {
  const op = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" }[operation.toLowerCase()];
  if (!op) throw new Error('operation must be "new", "add", "remove" or "intersect"');
  const params = [
    enumP("bodyType", "ExtendedToolBodyType", "SOLID"),
    enumP("operationType", "NewBodyOperationType", op),
    qList("entities", [sketchRegions(sketch_id, include_islands)]),
    qList("axis", [sketchEdge(sketch_id, axis_entity_id)]),
  ];
  if (angle >= 360) params.push(enumP("revolveType", "RevolveType", "FULL"));
  else {
    params.push(enumP("revolveType", "RevolveType", "ONE_DIRECTION"));
    params.push({ btType: "BTMParameterQuantity-147", parameterId: "angle", isInteger: false, value: 0, units: "", expression: `${angle} deg` });
  }
  return { btType: "BTMFeature-134", featureType: "revolve", name: name || "Revolve", suppressed: false, parameters: params };
}

// ---------- patterns ----------
// Pattern directions/axes are helper construction lines in a hidden-by-name sketch, built by helperAxis().
/**
 * Plan the helper geometry for a world-aligned line through point `at` (mm).
 * axis x: at=[y,z]  (line on a top-parallel plane at height z, along X)
 * axis y: at=[x,z]  (top-parallel plane at height z, along Y)
 * axis z: at=[x,y]  (front-parallel plane at y, vertical line at x)
 */
export function helperAxisPlan(axis, at = [0, 0]) {
  const [a, b] = at;
  switch (axis.toLowerCase()) {
    case "x": return { base: "top", offset: b, line: { x1: 0, y1: a, x2: 50, y2: a } };
    case "y": return { base: "top", offset: b, line: { x1: a, y1: 0, x2: a, y2: 50 } };
    case "z": return { base: "front", offset: -b, line: { x1: a, y1: 0, x2: a, y2: 50 } }; // front normal is -Y
    default: throw new Error('axis must be "x", "y" or "z"');
  }
}

const countP = (n) => ({ btType: "BTMParameterQuantity-147", parameterId: "instanceCount", isInteger: true, value: 0, units: "", expression: String(Math.round(n)) });

function patternTarget(kind, feature_id) {
  if (kind === "feature") {
    return [{ btType: "BTMParameterFeatureList-1699", parameterId: "instanceFunction", featureIds: [feature_id] },
            enumP("patternType", "PatternType", "FEATURE")];
  }
  return [qList("entities", [fsQuery(`qCreatedBy(makeId("${feature_id}"), EntityType.BODY)`)]),
          enumP("patternType", "PatternType", "PART")];
}

export function buildLinearPattern({ name, feature_id, kind = "part", helper_sketch_id, helper_entity_id, spacing, count }) {
  if (!(count >= 2)) throw new Error("count must be >= 2");
  return {
    btType: "BTMFeature-134", featureType: "linearPattern", name: name || "Linear pattern", suppressed: false,
    parameters: [
      ...patternTarget(kind, feature_id),
      qList("directionOne", [sketchEdge(helper_sketch_id, helper_entity_id)]),
      lenP("distance", spacing),
      countP(count),
    ],
  };
}

export function buildCircularPattern({ name, feature_id, kind = "part", helper_sketch_id, helper_entity_id, count, angle = 360 }) {
  if (!(count >= 2)) throw new Error("count must be >= 2");
  return {
    btType: "BTMFeature-134", featureType: "circularPattern", name: name || "Circular pattern", suppressed: false,
    parameters: [
      ...patternTarget(kind, feature_id),
      qList("axis", [sketchEdge(helper_sketch_id, helper_entity_id)]),
      { btType: "BTMParameterQuantity-147", parameterId: "angle", isInteger: false, value: 0, units: "", expression: `${angle} deg` },
      boolP("equalSpace", angle >= 360),
      countP(count),
    ],
  };
}

// ---------- face discovery (for sketching on existing faces) ----------
export function planarFaces(details) {
  // Onshape may give vectors as [x,y,z] or {x,y,z}, and bodies/faces under slightly different keys: accept all.
  const vec = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v.x, v.y, v.z] : null);
  const bodies = details.bodies || details.parts || (Array.isArray(details) ? details : []);
  const out = [], seen = [];
  for (const body of bodies) {
    for (const f of body.faces || []) {
      seen.push(f);
      const sf = f.surface || f.geometry || {};
      const type = String(sf.type || sf.surfaceType || "").toLowerCase();
      const n = vec(sf.normal), o = vec(sf.origin || sf.point);
      if (type !== "plane" && !(n && !type)) continue;
      if (!n || !o || n.some((x) => typeof x !== "number") || o.some((x) => typeof x !== "number")) continue;
      const m = (v) => +(v * 1000).toFixed(3), nr = (v) => +v.toFixed(3);
      out.push({
        face_id: f.id ?? f.faceId, body_id: body.id ?? body.bodyId,
        normal: n.map(nr), origin_mm: o.map(m),
        ...(f.area != null ? { area_mm2: +(f.area * 1e6).toFixed(1) } : {}),
      });
    }
  }
  if (!out.length && seen.length) return { note: "No planar faces recognised; raw face keys follow so the format can be fixed", keys: Object.keys(seen[0]), surface_keys: Object.keys(seen[0].surface || {}) };
  return out;
}

// ---------- shell / mirror / sweep / loft ----------
const OPS = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" };
const opOf = (operation) => { const o = OPS[String(operation).toLowerCase()]; if (!o) throw new Error('operation must be "new", "add", "remove" or "intersect"'); return o; };
const capFace = (id, which) => `qCapEntity(makeId("${id}"), CapType.${which}, EntityType.FACE)`;

/** Hollow out a body made by an extrude: remove its top and/or bottom face and leave walls of `thickness`. */
export function buildShell({ name, feature_id, thickness, open = "top", outward = false }) {
  const faces = { top: capFace(feature_id, "END"), bottom: capFace(feature_id, "START") };
  const q = open === "both" ? `qUnion(${faces.top}, ${faces.bottom})` : faces[open];
  if (!q) throw new Error('open must be "top", "bottom" or "both"');
  if (!(thickness > 0)) throw new Error("thickness must be > 0");
  return {
    btType: "BTMFeature-134", featureType: "shell", name: name || "Shell", suppressed: false,
    parameters: [qList("entities", [fsQuery(q)]), lenP("thickness", thickness), ...(outward ? [boolP("oppositeDirection", true)] : [])],
  };
}

/** Mirror the bodies created by a feature across a standard plane (top/front/right). */
export function buildMirror({ name, feature_id, plane = "right" }) {
  return {
    btType: "BTMFeature-134", featureType: "mirror", name: name || "Mirror", suppressed: false,
    parameters: [
      enumP("mirrorType", "MirrorType", "PART"),
      qList("entities", [fsQuery(`qCreatedBy(makeId("${feature_id}"), EntityType.BODY)`)]),
      qList("mirrorPlane", [planeQuery(plane)]),
    ],
  };
}

/** Sweep the region(s) of one sketch along the edges of another (the path). */
export function buildSweep({ name, profile_sketch_id, path_sketch_id, operation = "NEW", include_islands = false }) {
  return {
    btType: "BTMFeature-134", featureType: "sweep", name: name || "Sweep", suppressed: false,
    parameters: [
      enumP("bodyType", "ExtendedToolBodyType", "SOLID"),
      enumP("operationType", "NewBodyOperationType", opOf(operation)),
      qList("profiles", [sketchRegions(profile_sketch_id, include_islands)]),
      qList("path", [fsQuery(`qCreatedBy(makeId("${path_sketch_id}"), EntityType.EDGE)`)]),
    ],
  };
}

/** Loft through the regions of two or more sketches, in the order given. */
export function buildLoft({ name, sketch_ids, operation = "NEW", include_islands = false }) {
  if (!Array.isArray(sketch_ids) || sketch_ids.length < 2) throw new Error("loft needs at least 2 sketch ids");
  return {
    btType: "BTMFeature-134", featureType: "loft", name: name || "Loft", suppressed: false,
    parameters: [
      enumP("bodyType", "ExtendedToolBodyType", "SOLID"),
      enumP("operationType", "NewBodyOperationType", opOf(operation)),
      {
        btType: "BTMParameterArray-2", parameterId: "profileSubqueries",
        items: sketch_ids.map((id) => ({ btType: "BTMArrayParameterItem-1362", parameters: [qList("profileSubquery", [sketchRegions(id, include_islands)])] })),
      },
    ],
  };
}

// ---------- naming and colouring parts ----------
const COLORS = {
  red: [220, 38, 38], green: [34, 160, 80], blue: [37, 99, 235], yellow: [250, 204, 21], orange: [249, 115, 22], purple: [147, 51, 234],
  pink: [236, 72, 153], black: [24, 24, 27], white: [245, 245, 245], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 198],
  brown: [120, 72, 40], cyan: [6, 182, 212], teal: [13, 148, 136], gold: [212, 175, 55], navy: [30, 41, 100], aluminum: [190, 194, 200], steel: [140, 146, 154],
};
/** "red" | "#ff8800" | "ff8800" | [r,g,b] (0-255) -> [r,g,b], or null */
export function parseColor(c) {
  if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v))) return c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  const t = String(c ?? "").trim().toLowerCase();
  if (COLORS[t]) return COLORS[t];
  const m = t.match(/^#?([0-9a-f]{6})$/);
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
export const COLOR_NAMES = Object.keys(COLORS);

/** Part ids (deterministic body ids) created by a feature. */
export async function partIdsForFeature(osh, ctx, featureId) {
  const parts = await osh.getParts(ctx);
  const known = new Set((Array.isArray(parts) ? parts : parts.parts || []).map((x) => x.partId));
  const script = `function(context is Context, queries is map) { return transientQueriesToStrings(evaluateQuery(context, qCreatedBy(makeId("${featureId}"), EntityType.BODY))); }`;
  const reply = await osh.evalFeatureScript(ctx, script);
  const found = new Set();
  const walk = (v) => { if (typeof v === "string") { if (known.has(v)) found.add(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(reply);
  return [...found];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metaDown = new Map();                       // document+element -> when its part metadata last failed for good
export const resetMetaDown = () => metaDown.clear();
const statusOf = (e) => e?.status ?? String(e?.message || e).slice(0, 80);
/**
 * Run a part-metadata call. Onshape can answer 404 for a moment after parts are created, so a 404 is retried with
 * growing waits; if it never appears, say what Onshape does know (so the cause can be told apart) and skip further
 * waits for this document for a short while.
 */
async function metaCall(osh, ctx, partId, fn) {
  const key = `${ctx.did}:${ctx.eid}`;
  if (Date.now() - (metaDown.get(key) || 0) < 45000) throw new Error("Onshape still has no part metadata for this document (it said 404 a moment ago), so styling was skipped");
  const delays = osh.metaDelays ?? [400, 700, 1000, 1300, 1600, 2000];
  let last;
  for (let n = 0; n <= delays.length; n++) {
    try { const r = await fn(); metaDown.delete(key); return r; }
    catch (e) { last = e; if (e.status !== 404) throw e; if (n < delays.length) await sleep(delays[n]); }
  }
  metaDown.set(key, Date.now());
  let elem; try { await osh.getElementMetadata(ctx); elem = "ok"; } catch (e) { elem = statusOf(e); }
  let listed; try { const r = await osh.getParts(ctx); listed = `${(Array.isArray(r) ? r : r.parts || []).length} parts listed`; } catch (e) { listed = `parts list ${statusOf(e)}`; }
  throw new Error(`Onshape has no metadata for part ${partId} (404 after ${delays.length + 1} tries over ${(delays.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s; element metadata: ${elem}; ${listed})`);
}

const propByName = (meta, name) => (meta.properties || []).find((p) => String(p.name).toLowerCase() === name);
/**
 * Set a part's name and/or colour and read it back to confirm. The colour is tried in the shapes Onshape might expect
 * (keeping the part's existing appearance object, plain, and 0-1 channels); the first one that reads back correctly wins.
 */
export async function stylePart(osh, ctx, partId, { name, color, opacity }) {
  const read = () => metaCall(osh, ctx, partId, () => osh.getPartMetadata(ctx, partId));
  const write = (props) => metaCall(osh, ctx, partId, () => osh.updatePartMetadata(ctx, partId, props));
  const meta = await read(), out = { partId };
  const pName = propByName(meta, "name"), pApp = propByName(meta, "appearance");
  if (name) {
    if (!pName) throw new Error("Onshape did not list a Name property for this part");
    await write([{ propertyId: pName.propertyId, value: String(name) }]);
  }
  if (color) {
    const rgb = parseColor(color); if (!rgb) throw new Error(`Unknown colour "${color}". Use a name (${COLOR_NAMES.slice(0, 8).join(", ")}…) or hex like #ff8800`);
    if (!pApp) throw new Error("Onshape did not list an Appearance property for this part");
    out.rgb = rgb;
    const cur = pApp.value && typeof pApp.value === "object" ? pApp.value : {};
    const op = Math.round((opacity ?? 1) * 255), [r, g, b] = rgb;
    const variants = [
      { ...cur, color: { red: r, green: g, blue: b }, opacity: op },
      { color: { red: r, green: g, blue: b }, opacity: op },
      { color: { red: r / 255, green: g / 255, blue: b / 255 }, opacity: op / 255 },
    ];
    const matches = (v) => v && [v.red, v.green, v.blue].every((x, i) => Math.abs(x - rgb[i]) <= 1 || Math.abs(x * 255 - rgb[i]) <= 1);
    let lastErr = null;
    for (const value of variants) {
      try {
        await write([{ propertyId: pApp.propertyId, value }]);
        const after = propByName(await read(), "appearance")?.value?.color;
        if (matches(after)) { out.colored = true; break; }
        lastErr = `Onshape accepted the colour but it reads back as ${JSON.stringify(after)}`;
      } catch (e) { lastErr = e.message; }
    }
    if (!out.colored) { out.colored = false; out.reason = String(lastErr || "unknown").slice(0, 300); }
  }
  if (name) out.named = propByName(await read(), "name")?.value === String(name);
  return out;
}

// ---------- editing an existing feature ----------
const OPERATIONS = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" };
/**
 * Change an existing feature in place: its operation (new/add/remove/intersect), depth, direction, name, suppression,
 * or any other enum/length/boolean parameter by id. Returns {feature, changed[]} (feature = the edited definition).
 */
export function applyFeatureChanges(feature, changes = {}) {
  const f = JSON.parse(JSON.stringify(feature)), changed = [];
  const find = (id) => (f.parameters || []).find((p) => p.parameterId === id);
  const setParam = (id, value) => {
    const p = find(id);
    if (!p) return false;
    if (String(p.btType).includes("Enum")) p.value = String(value);
    else if (String(p.btType).includes("Quantity")) p.expression = typeof value === "number" ? `${value} mm` : String(value);
    else if (String(p.btType).includes("Boolean")) p.value = !!value;
    else throw new Error(`Parameter "${id}" has a type that cannot be edited this way`);
    return true;
  };
  if (changes.name) { f.name = String(changes.name); changed.push("name"); }
  if (changes.suppressed !== undefined) { f.suppressed = !!changes.suppressed; changed.push(f.suppressed ? "suppressed" : "unsuppressed"); }
  if (changes.operation) {
    const op = OPERATIONS[String(changes.operation).toLowerCase()];
    if (!op) throw new Error('operation must be "new", "add", "remove" or "intersect"');
    if (!setParam("operationType", op)) throw new Error("This feature has no operation mode (only extrude, revolve, loft and sweep do)");
    changed.push(`operation=${op}`);
  }
  if (changes.depth !== undefined) {
    if (!(changes.depth > 0)) throw new Error("depth must be > 0");
    if (!setParam("depth", changes.depth)) throw new Error("This feature has no depth");
    changed.push(`depth=${changes.depth} mm`);
  }
  if (changes.direction) {
    const d = String(changes.direction).toLowerCase();
    if (!["normal", "reverse", "symmetric"].includes(d)) throw new Error('direction must be "normal", "reverse" or "symmetric"');
    if (!find("endBound")) throw new Error("This feature has no direction setting");
    setParam("endBound", d === "symmetric" ? "SYMMETRIC" : "BLIND");
    if (find("oppositeDirection")) setParam("oppositeDirection", d === "reverse");
    else if (d === "reverse") f.parameters.push(boolP("oppositeDirection", true));
    changed.push(`direction=${d}`);
  }
  for (const [id, v] of Object.entries(changes.parameters || {})) {
    if (!setParam(id, v)) throw new Error(`This feature has no parameter "${id}"`);
    changed.push(`${id}=${v}`);
  }
  if (!changed.length) throw new Error("Nothing to change: give operation, depth, direction, name, suppressed or parameters");
  return { feature: f, changed };
}
