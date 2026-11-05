import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "cal-"));
process.env.CLAUDESHAPE_TMP = process.env.HOME;
const { Onshape, tuning, buildRevolve, setRevolveVariant, revolveFlip } = await import("../lib/onshape.js");
const { calibrateRevolve, loadRevolveCal, applyRevolveCal } = await import("../lib/calib.js");
const { runTool } = await import("../lib/agent.js");

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
