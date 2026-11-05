// Thin Onshape REST client + builders for Part Studio feature JSON.
// All Onshape lengths are in metres; helpers here accept millimetres.

const BASE = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";
const mm = (v) => v / 1000;

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
  deleteFeature(ctx, id) { return this.request("DELETE", `${this.ps(ctx)}/features/featureid/${encodeURIComponent(id)}`); }
  getBoundingBox(ctx) { return this.request("GET", `${this.ps(ctx)}/boundingboxes`); }
  getParts(ctx) { return this.request("GET", `/api/parts/d/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`); }
  whoami() { return this.request("GET", "/api/users/sessioninfo"); }
  listDocuments(q) { return this.request("GET", `/api/documents?q=${encodeURIComponent(q || "")}&limit=20`); }
  getWorkspaceElements(did, wid) { return this.request("GET", `/api/documents/d/${did}/w/${wid}/elements`); }
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
  const name = STANDARD_PLANES[plane.toLowerCase()];
  if (!name) throw new Error(`Unknown plane "${plane}". Use top, front, right, or a plane feature id as "feature:<id>".`);
  return fsQuery(`qCreatedBy(makeId("${name}"), EntityType.FACE)`);
}

// ---------- sketch ----------
/**
 * shapes: array of
 *  {type:"circle", cx, cy, r}
 *  {type:"rectangle", x, y, width, height}           (x,y = lower-left corner)
 *  {type:"polygon", points:[[x,y],...]}              (closed)
 *  {type:"regular_polygon", cx, cy, r, sides, rotation_deg?}   (r = circumradius)
 *  {type:"slot", cx, cy, length, width, angle_deg?}  (stadium shape, length is overall)
 *  {type:"arc"...} not supported; compose with polygon/slot/circle.
 * all dimensions in mm.
 */
export function buildSketch({ name, plane, shapes }) {
  const entities = [];
  let n = 0;
  const line = (x1, y1, x2, y2, id) => {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1e-9) throw new Error("Zero-length sketch edge");
    return {
      btType: "BTMSketchCurveSegment-155", entityId: id,
      startPointId: `${id}.start`, endPointId: `${id}.end`,
      startParam: 0, endParam: mm(len),
      geometry: { btType: "BTCurveGeometryLine-117", pntX: mm(x1), pntY: mm(y1), dirX: dx / len, dirY: dy / len },
    };
  };
  const loop = (pts) => {
    if (pts.length < 3) throw new Error("A polygon needs at least 3 points");
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      entities.push(line(p[0], p[1], q[0], q[1], `e${n++}`));
    });
  };
  const arc = (cx, cy, r, a0, a1, id) => ({
    // counter-clockwise arc a0 -> a1 (radians)
    btType: "BTMSketchCurveSegment-155", entityId: id,
    startPointId: `${id}.start`, endPointId: `${id}.end`, centerId: `${id}.center`,
    startParam: a0, endParam: a1,
    geometry: { btType: "BTCurveGeometryCircle-115", radius: mm(r), xCenter: mm(cx), yCenter: mm(cy), xDir: 1, yDir: 0, clockwise: false },
  });

  for (const s of shapes) {
    switch (s.type) {
      case "circle": {
        if (!(s.r > 0)) throw new Error("circle needs r > 0");
        const id = `e${n++}`;
        entities.push({
          btType: "BTMSketchCurve-4", entityId: id, centerId: `${id}.center`,
          geometry: { btType: "BTCurveGeometryCircle-115", radius: mm(s.r), xCenter: mm(s.cx ?? 0), yCenter: mm(s.cy ?? 0), xDir: 1, yDir: 0, clockwise: false },
        });
        break;
      }
      case "rectangle": {
        const x = s.x ?? 0, y = s.y ?? 0;
        if (!(s.width > 0 && s.height > 0)) throw new Error("rectangle needs width,height > 0");
        loop([[x, y], [x + s.width, y], [x + s.width, y + s.height], [x, y + s.height]]);
        break;
      }
      case "polygon":
        loop(s.points);
        break;
      case "regular_polygon": {
        const k = Math.round(s.sides);
        if (k < 3) throw new Error("regular_polygon needs sides >= 3");
        const rot = ((s.rotation_deg ?? 0) * Math.PI) / 180;
        const pts = [...Array(k)].map((_, i) => {
          const a = rot + (2 * Math.PI * i) / k;
          return [(s.cx ?? 0) + s.r * Math.cos(a), (s.cy ?? 0) + s.r * Math.sin(a)];
        });
        loop(pts);
        break;
      }
      case "slot": {
        const { length, width } = s;
        if (!(width > 0 && length > width)) throw new Error("slot needs length > width > 0");
        const ang = ((s.angle_deg ?? 0) * Math.PI) / 180;
        const r = width / 2, half = length / 2 - r;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const T = (x, y) => [(s.cx ?? 0) + x * c - y * sn, (s.cy ?? 0) + x * sn + y * c];
        const [l0, l1] = [T(-half, -r), T(half, -r)];
        const [u0, u1] = [T(half, r), T(-half, r)];
        const cR = T(half, 0), cL = T(-half, 0);
        entities.push(line(...l0, ...l1, `e${n++}`));
        entities.push(arc(cR[0], cR[1], r, ang - Math.PI / 2, ang + Math.PI / 2, `e${n++}`));
        entities.push(line(...u0, ...u1, `e${n++}`));
        entities.push(arc(cL[0], cL[1], r, ang + Math.PI / 2, ang + (3 * Math.PI) / 2, `e${n++}`));
        break;
      }
      default:
        throw new Error(`Unknown shape type "${s.type}"`);
    }
  }
  return {
    btType: "BTMSketch-151", featureType: "newSketch", name: name || "Sketch", suppressed: false,
    parameters: [qList("sketchPlane", [planeQuery(plane)])],
    entities, constraints: [],
  };
}

// ---------- extrude ----------
export function buildExtrude({ name, sketch_id, depth, operation = "NEW", direction = "normal", second_depth }) {
  const op = { new: "NEW", add: "ADD", remove: "REMOVE", intersect: "INTERSECT" }[operation.toLowerCase()];
  if (!op) throw new Error('operation must be "new", "add", "remove" or "intersect"');
  const dir = direction.toLowerCase();
  const params = [
    enumP("bodyType", "ExtendedToolBodyType", "SOLID"),
    enumP("operationType", "NewBodyOperationType", op),
    qList("entities", [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: sketch_id, queryString: "", deterministicIds: [] }]),
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
export function buildEdgeFeature(kind, { name, feature_id, size }) {
  const q = qCreatedByEdges(feature_id);
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
const qCreatedByEdges = (id) => fsQuery(`qCreatedBy(makeId("${id}"), EntityType.EDGE)`);

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
