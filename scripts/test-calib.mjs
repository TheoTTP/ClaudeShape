import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "cal-"));
process.env.CLAUDESHAPE_TMP = process.env.HOME;
const { Onshape, tuning, buildRevolve, setRevolveVariant, revolveFlip } = await import("../lib/onshape.js");
const { calibrateRevolve, loadRevolveCal, applyRevolveCal } = await import("../lib/calib.js");
const { runTool } = await import("../lib/agent.js");
const { findLoftTemplate, learnLoft, loadLoft } = await import("../lib/learn.js");
const { buildLoft, setLoftTemplate } = await import("../lib/onshape.js");

// ---- 1. "429 Too many requests": wait and retry, a few at a time ----
tuning.backoffMs = 1;
const realFetch = globalThis.fetch;
const reply = (status, body = {}, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls <= 2 ? reply(429, { message: "Too many requests" }, { "retry-after": "0" }) : reply(200, { ok: true }); };
  assert.deepEqual(await new Onshape({ accessKey: "a", secretKey: "b" }).request("GET", "/api/documents"), { ok: true });
  assert.equal(calls, 3, "two 429s were waited out");

  calls = 0; globalThis.fetch = async () => { calls++; return reply(429, { message: "Too many requests" }); };
  const err = await new Onshape({ accessKey: "a", secretKey: "b" }).request("GET", "/api/x").catch((e) => e);
  assert.equal(err.status, 429); assert.equal(calls, 6, "gives up after 6 tries and reports it");

  let now = 0, peak = 0;
  globalThis.fetch = async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; return reply(200, {}); };
  const o = new Onshape({ accessKey: "a", secretKey: "b" });
  await Promise.all([...Array(12)].map(() => o.request("GET", "/api/x")));
  assert.ok(peak <= tuning.maxParallel, `at most ${tuning.maxParallel} at once, saw ${peak}`);
  globalThis.fetch = realFetch;
}

// ---- 2. self-test: find the revolve-angle style Onshape obeys ----
const fakeOnshape = (obeys) => {
  const log = { added: [], deleted: [] };
  let last = null;
  return { log,
    createDocument: async () => ({ id: "D", defaultWorkspace: { id: "W" } }),
    getWorkspaceElements: async () => [{ id: "E", elementType: "PARTSTUDIO" }],
    addFeature: async (_c, f) => {
      log.added.push(f); const id = "F" + log.added.length;
      if (f.featureType === "revolve") { const ids = f.parameters.map((p) => p.parameterId); last = obeys(ids, f); }
      return { feature: { featureId: id }, featureState: { featureStatus: "OK" } };
    },
    getBoundingBox: async () => (last === "partial" ? { lowZ: 0, highZ: 0.055 } : last === "partial-down" ? { lowZ: -0.055, highZ: 0 } : { lowZ: -0.055, highZ: 0.055 }),
    deleteFeature: async (_c, id) => { log.deleted.push(id); },
  };
};
{
  // this "Onshape" only honours the two-direction style (v3 / v5)
  const osh = fakeOnshape((ids) => (ids.includes("angleBack") && ids.includes("angle") ? "partial" : "full"));
  const r = await calibrateRevolve(osh);
  assert.equal(r.variant, "v3"); assert.equal(r.flip, false);
  assert.deepEqual(osh.log.deleted, ["F2", "F3"], "the rings from the styles that failed are removed (feature F1 is the test sketch)");
  assert.equal(loadRevolveCal().variant, "v3");
  setRevolveVariant("v1"); applyRevolveCal();                                           // a later start-up re-applies it
  const rev = buildRevolve({ sketch_id: "S", axis_entity_id: "axis", angle: 30 });
  assert.ok(rev.parameters.some((p) => p.parameterId === "angleBack") && rev.parameters.find((p) => p.parameterId === "angle").expression === "30 deg");
  const before = osh.log.added.length; await calibrateRevolve(osh); assert.equal(osh.log.added.length, before, "once calibrated it is not repeated");

  // a style that turns the wrong way is accepted, and remembered as flipped
  fs.rmSync(path.join(process.env.HOME, ".claudeshape-revolve.json"));
  const down = await calibrateRevolve(fakeOnshape(() => "partial-down"));
  assert.equal(down.variant, "v1"); assert.equal(down.flip, true); assert.equal(revolveFlip(), true);
  const { expandMacro } = await import("../lib/agent.js");
  const ax = expandMacro({ tool: "bend_tube", input: { radius: 600, method: "revolve", sections: [{ length: 20, r: 10 }] } }, "h").find((x) => x.tool === "create_sketch").input.shapes[1];
  assert.ok(ax.y1 > ax.y2, "bend axis is reversed automatically when the test showed it turning downward");

  // nothing works -> remembered as a failure, not retried for a day, and v1 stays the default
  fs.rmSync(path.join(process.env.HOME, ".claudeshape-revolve.json")); setRevolveVariant("v1");
  const bad = fakeOnshape(() => "full");
  assert.equal(await calibrateRevolve(bad), null);
  assert.equal(loadRevolveCal().tried.length, 6); assert.ok(loadRevolveCal().failedAt);
  const n = bad.log.added.length; assert.equal(await calibrateRevolve(bad), null); assert.equal(bad.log.added.length, n);
  assert.ok((await calibrateRevolve(bad, { force: true })) === null && bad.log.added.length > n, "can be forced to try again");
}

// ---- 3. a "curved" tube that comes out as a full ring is caught and removed ----
{
  setRevolveVariant("v1", false);
  const deleted = [];
  const mk = (zRangeM) => ({
    addFeature: async (_c, f) => ({ feature: { featureId: "X" + Math.random().toString(36).slice(2, 6), constraints: f.constraints }, featureState: { featureStatus: "OK" } }),
    deleteFeature: async (_c, id) => { deleted.push(id); },
    getBoundingBox: async () => ({ lowX: 0, lowY: 0, lowZ: -zRangeM / 2, highX: 0, highY: 0, highZ: zRangeM / 2 }),
    getParts: async () => [],
  });
  const steps = [{ tool: "bend_tube", input: { radius: 600, method: "revolve", sections: [{ length: 40, r: 12 }, { length: 60, r: 14 }] } }];
  const ring = await runTool(mk(1.2), {}, "build_steps", { preview: false, steps });       // 1200 mm across: a full ring
  assert.match(ring.error, /ignored the partial revolve angle/); assert.ok(deleted.length >= 2, "what was built is removed");
  const fine = await runTool(mk(0.1), {}, "build_steps", { preview: false, steps });        // 100 mm: a short curved piece
  assert.equal(fine.error, undefined);
}
console.log("calibration tests passed");

// ---- 4. one sketch for the whole tube: each revolve picks its region by a point, and its own axis ----
{
  const { expandMacro } = await import("../lib/agent.js");
  const { setRegionPoint, buildSketch, buildExtrude } = await import("../lib/onshape.js");
  const { calibrateRegionPoint, loadRegionCal, applyRegionCal } = await import("../lib/calib.js");
  const R = 500;
  const secs = [{ length: 22, r: 15, name: "pommel", color: "silver" }, { length: 70, r: 13, name: "grip", color: "black" }, { length: 6, r: 17 }, { length: 40, r: 18, name: "emitter", color: "silver" }];
  const input = { radius: R, sections: secs, name: "Hilt" };

  setRegionPoint(false);
  const slow = expandMacro({ tool: "bend_tube", input }, "h");
  setRegionPoint(true);
  const fast = expandMacro({ tool: "bend_tube", input }, "h");
  const count = (st, t) => st.filter((x) => x.tool === t).length;
  const sketches = fast.filter((x) => x.tool === "create_sketch");
  assert.ok(sketches.length >= 2 && sketches.length <= 4, "a few shared sketches instead of one per piece, got " + sketches.length);
  assert.equal(count(fast, "revolve"), count(slow, "revolve"), "same bodies");
  assert.ok(count(fast, "create_sketch") + count(fast, "revolve") < count(slow, "create_sketch") + count(slow, "revolve"), "fewer features");
  {                                                            // a longer, finer tube saves more (the more pieces, the closer to half)
    const long = { radius: 300, max_step_deg: 3, sections: [{ length: 60, r: 14 }, { length: 8, r: 18 }, { length: 90, r: 12 }, { length: 8, r: 18 }, { length: 70, r: 15 }] };
    setRegionPoint(false); const a = expandMacro({ tool: "bend_tube", input: long }, "h"); setRegionPoint(true); const b = expandMacro({ tool: "bend_tube", input: long }, "h");
    assert.ok(b.filter((x) => x.tool === "create_sketch" || x.tool === "revolve").length < 0.65 * a.filter((x) => x.tool === "create_sketch" || x.tool === "revolve").length, "about 40% fewer features on a long tube");
  }
  assert.ok(fast.findIndex((x) => x.tool === "create_sketch") < fast.findIndex((x) => x.tool === "revolve"), "the sketches come before the revolves");
  assert.ok(fast.filter((x) => x.tool === "create_sketch").every((x) => fast.indexOf(x) < fast.findIndex((y) => y.tool === "revolve")));
  assert.deepEqual(fast.filter((x) => x.tool === "style_part").map((x) => x.input.color), slow.filter((x) => x.tool === "style_part").map((x) => x.input.color));

  // geometry, per shared sketch: shapes inside one sketch must not overlap, each revolve's point is inside ITS region only,
  // and its axis is that region's own edge
  const inPoly = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { if (((poly[i][1] > pt[1]) !== (poly[j][1] > pt[1])) && pt[0] < ((poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c; } return c; };
  const segOf = (e) => { const g = e.geometry; return [[g.pntX * 1000, g.pntY * 1000], [(g.pntX + g.dirX * e.endParam) * 1000, (g.pntY + g.dirY * e.endParam) * 1000]]; };
  const halfDisc = (sh) => { const c = [(sh.start[0] + sh.segments[0].to[0]) / 2, (sh.start[1] + sh.segments[0].to[1]) / 2]; return { c, r: sh.segments[0].radius }; };
  const overlap = (A, B) => {                                  // do two shapes of one sketch overlap? (sample points of each against the other)
    const samples = (sh) => { if (sh.type === "polygon") { const p = sh.points; return [...p, ...p.map((v, i) => [(v[0] + p[(i + 1) % 4][0]) / 2, (v[1] + p[(i + 1) % 4][1]) / 2]), [p.reduce((t, v) => t + v[0], 0) / 4, p.reduce((t, v) => t + v[1], 0) / 4]]; } const { c, r } = halfDisc(sh); return [c, [c[0] + r * 0.5, c[1]], [c[0] - r * 0.5, c[1]], [c[0], c[1] + r * 0.5], [c[0], c[1] - r * 0.5]]; };
    const inside = (pt, sh) => (sh.type === "polygon" ? inPoly(pt, sh.points) : (() => { const { c, r } = halfDisc(sh); return Math.hypot(pt[0] - c[0], pt[1] - c[1]) < r - 1e-6; })());
    return samples(A).some((pt) => inside(pt, B)) || samples(B).some((pt) => inside(pt, A));
  };
  const revs = fast.filter((x) => x.tool === "revolve"), bySketch = {};
  for (const sk of sketches) bySketch[sk.as] = { shapes: sk.input.shapes, built: buildSketch({ plane: "front", shapes: sk.input.shapes }), next: 0, ent: 0, regions: [] };
  for (const g of Object.values(bySketch)) {
    g.shapes.forEach((sh, a) => g.shapes.forEach((sh2, b) => { if (b > a && sh.type === "polygon" && sh2.type === "polygon") assert.ok(!overlap(sh, sh2), "no two pieces of one sketch overlap"); }));
    for (const sh of g.shapes) { if (sh.type === "polygon") { g.regions.push({ kind: "poly", pts: sh.points, axis: `e${g.ent + 3}` }); g.ent += 4; } else { g.regions.push({ kind: "joint", ...halfDisc(sh), axis: `e${g.ent + 1}` }); g.ent += 2; } }
  }
  for (const rv of revs) {
    const g = bySketch[rv.input.sketch_id.replace(/^\$/, "")], reg = g.regions[g.next++], pt = [rv.input.region_point[0], rv.input.region_point[2]];
    assert.equal(rv.input.region_point[1], 0, "the Front plane is y = 0");
    assert.equal(rv.input.axis_entity_id, reg.axis);
    const byId = Object.fromEntries(g.built.entities.map((e) => [e.entityId, e]));
    if (reg.kind === "poly") {
      assert.ok(inPoly(pt, reg.pts), "the point is inside its own piece");
      assert.ok(g.regions.every((o) => o === reg || o.kind !== "poly" || !inPoly(pt, o.pts)), "and inside no other piece of that sketch");
      const [a, b] = segOf(byId[reg.axis]);                      // the axis edge runs P1 -> P0 of this piece
      assert.ok(Math.hypot(a[0] - reg.pts[3][0], a[1] - reg.pts[3][1]) < 1e-6 && Math.hypot(b[0] - reg.pts[0][0], b[1] - reg.pts[0][1]) < 1e-6);
    } else {
      assert.ok(Math.hypot(pt[0] - reg.c[0], pt[1] - reg.c[1]) < reg.r, "inside the half disc");
      assert.ok(byId[reg.axis].geometry.btType.includes("Line"), "the joint's axis is its diameter line");
      assert.ok(g.regions.every((o) => o === reg || o.kind !== "joint" || Math.hypot(pt[0] - o.c[0], pt[1] - o.c[1]) >= o.r), "and in no other joint of that sketch");
    }
  }
  assert.ok(Object.values(bySketch).every((g) => g.next === g.regions.length), "every region is used exactly once");

  // the query text
  const rv = buildExtrude({ sketch_id: "S9", depth: 5, region_point: [15, 0, 15] });
  assert.match(rv.parameters.find((p) => p.parameterId === "entities").queries[0].queryString, /qContainsPoint\(qSketchRegion\(makeId\("S9"\), true\), vector\(15\.000000, 0\.000000, 15\.000000\) \* millimeter\)/);

  // ---- the self-test for it ----
  const osh = (xRange) => ({ createDocument: async () => ({ id: "D", defaultWorkspace: { id: "W" } }), getWorkspaceElements: async () => [{ id: "E", elementType: "PARTSTUDIO" }],
    addFeature: async () => ({ feature: { featureId: "F" }, featureState: { featureStatus: "OK" } }), getBoundingBox: async () => ({ lowX: xRange[0] / 1000, highX: xRange[1] / 1000 }), deleteFeature: async () => ({}) });
  setRegionPoint(false); try { fs.rmSync(path.join(process.env.HOME, ".claudeshape-region.json")); } catch {}
  const bad = osh([10, 50]);                                         // both rectangles became bodies: the point was ignored
  assert.equal(await calibrateRegionPoint(bad), null); assert.equal(regionPointOKnow(), false);
  const n = 0; assert.equal(await calibrateRegionPoint(bad), null);       // remembered for a day
  const good = osh([10, 20]);
  assert.ok((await calibrateRegionPoint(good, { force: true })).ok); assert.equal(regionPointOKnow(), true);
  setRegionPoint(false); applyRegionCal(); assert.equal(regionPointOKnow(), true, "applied again on the next start");
  setRegionPoint(false);
  function regionPointOKnow() { return expandMacro({ tool: "bend_tube", input }, "h").filter((x) => x.tool === "create_sketch").length <= 4; }
}
console.log("shared sketch tests passed");


// ---- 5. learning how a real loft writes its profile list ----
{
  const real = { featureType: "loft", parameters: [
    { btType: "BTMParameterEnum-145", parameterId: "bodyType", value: "SOLID" },
    { btType: "BTMParameterArray-9999", parameterId: "sections", items: [{ btType: "BTMArrayParameterItem-7777", parameters: [{ btType: "BTMParameterQueryList-148", parameterId: "sectionQuery", queries: [] }] }, { btType: "BTMArrayParameterItem-7777", parameters: [] }] }] };
  assert.deepEqual(findLoftTemplate([{ featureType: "extrude" }, real]), { array: { btType: "BTMParameterArray-9999", parameterId: "sections" }, item: { btType: "BTMArrayParameterItem-7777" }, inner: { parameterId: "sectionQuery", btType: "BTMParameterQueryList-148" } });
  assert.equal(findLoftTemplate([{ featureType: "loft", parameters: [{ btType: "BTMParameterArray-1", parameterId: "x", items: [] }] }]), null);

  // default encoding, as sent before anything is learned
  setLoftTemplate(null);
  const dflt = buildLoft({ sketch_ids: ["S1", "S2"] }).parameters.find((p) => p.parameterId === "profileSubqueries");
  assert.equal(dflt.btType, "BTMParameterArray-2025"); assert.equal(dflt.items[0].btType, "BTMArrayParameterItem-1362");

  // learned from a (fake) public document -> used exactly as Onshape wrote it
  const fake = { request: async (m, url) => { if (url.startsWith("/api/documents?")) return { items: [{ id: "D", defaultWorkspace: { id: "W" } }] }; if (url.includes("/elements")) return [{ id: "E" }]; return { features: [real] }; } };
  assert.ok(await learnLoft(fake, { pauseMs: 0 }));
  const t = loadLoft(); assert.equal(t.array.parameterId, "sections");
  setLoftTemplate(t);
  const learnedLoft = buildLoft({ sketch_ids: ["S1", "S2", "S3"] }).parameters.find((p) => p.parameterId === "sections");
  assert.equal(learnedLoft.btType, "BTMParameterArray-9999"); assert.equal(learnedLoft.items.length, 3);
  assert.equal(learnedLoft.items[2].btType, "BTMArrayParameterItem-7777");
  assert.equal(learnedLoft.items[2].parameters[0].parameterId, "sectionQuery");
  assert.match(learnedLoft.items[2].parameters[0].queries[0].queryString, /makeId\("S3"\)/);
  let calls = 0; const again = await learnLoft({ request: async () => { calls++; return {}; } }, { pauseMs: 0 }); assert.ok(again); assert.equal(calls, 0, "once learned, never searched again");

  // nothing found -> remembered as a failure for a day
  fs.rmSync(path.join(process.env.HOME, ".claudeshape-loft.json")); setLoftTemplate(null);
  assert.equal(await learnLoft({ request: async () => ({ items: [] }) }, { pauseMs: 0 }), null);
  calls = 0; assert.equal(await learnLoft({ request: async () => { calls++; return {}; } }, { pauseMs: 0 }), null); assert.equal(calls, 0);
}
console.log("loft learning tests passed");

// ---- 6. rate-limit waits are counted so the window can say so ----
{
  const { takeRateWait } = await import("../lib/onshape.js");
  takeRateWait();
  tuning.backoffMs = 3; let c = 0;
  globalThis.fetch = async () => { c++; return c <= 2 ? { status: 429, ok: false, headers: { get: () => null }, text: async () => "{}" } : { status: 200, ok: true, headers: { get: () => null }, text: async () => "{}" }; };
  await new Onshape({ accessKey: "a", secretKey: "b" }).request("GET", "/api/x");
  const w = takeRateWait(); assert.ok(w > 0, "it noted that it waited"); assert.equal(takeRateWait(), 0, "and reset the counter");
  globalThis.fetch = realFetch;
}
console.log("rate limit wait tests passed");
