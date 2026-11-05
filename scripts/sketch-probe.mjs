// Finds out what Onshape really does with sketch constraints, using a scratch document in your account.
//   node scripts/sketch-probe.mjs                 try several constraint styles, report which ones Onshape keeps
//   node scripts/sketch-probe.mjs --shapes        one sketch per shape type with the real constraints (all should be black)
//   node scripts/sketch-probe.mjs --dump <url>    print the constraints of every sketch in a document (e.g. one you drew by hand)
// Full details are saved to ~/.claudeshape-probe.json; the printed summary is short enough to paste back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Onshape, buildSketch, fixConstraints } from "../lib/onshape.js";
import { createDocumentWithStudio } from "../lib/doc.js";
import { loadKeys } from "../lib/config.js";

const keys = loadKeys();
if (!keys) { console.error("No Onshape keys saved yet. Open ClaudeShape once and finish the setup."); process.exit(1); }
const osh = new Onshape(keys);
const OUT = path.join(os.homedir(), ".claudeshape-probe.json");
const report = {};

const summarize = (cons = []) => cons.map((c) => ({
  type: c.constraintType,
  params: (c.parameters || []).map((p) => `${p.parameterId}=${p.value ?? p.expression ?? ""}`),
}));

async function dump(url) {
  const m = url.match(/documents\/([0-9a-f]+)\/(?:w|v|m)\/([0-9a-f]+)\/e\/([0-9a-f]+)/i);
  if (!m) throw new Error("Give the full Onshape URL of the Part Studio");
  const ctx = { did: m[1], wid: m[2], eid: m[3] };
  const feats = (await osh.getFeatures(ctx)).features || [];
  for (const f of feats.filter((x) => x.featureType === "newSketch")) {
    console.log(`\nSketch "${f.name}": ${f.entities?.length || 0} entities, ${f.constraints?.length || 0} constraints`);
    for (const c of summarize(f.constraints)) console.log("  ", c.type, c.params.join(" "));
    report[f.name] = { entities: f.entities, constraints: f.constraints };
  }
}

async function probe() {
  const ctx = await createDocumentWithStudio(osh, "ClaudeShape probe (delete me)");
  console.log("Scratch document:", `https://cad.onshape.com/documents/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`);
  const shapes = [{ type: "rectangle", x: 0, y: 0, width: 60, height: 40 }, { type: "circle", cx: 30, cy: 20, r: 5 }];
  const base = buildSketch({ plane: "top", shapes });
  const { _label, ...plain } = base;
  const pointFix = (ents) => ents.flatMap((e) => {
    const pts = e.centerId ? [e.centerId] : [e.startPointId, e.endPointId];
    return pts.map((pt, i) => ({ btType: "BTMSketchConstraint-2", constraintType: "FIX", entityId: `pf.${e.entityId}.${i}`, parameters: [{ btType: "BTMParameterString-149", parameterId: "localFirst", value: pt }] }));
  });
  const variants = {
    "A parametric (joints, H/V, dimensions, anchor)": base.constraints,
    "B every entity locked (FIX on entities)": fixConstraints(base.entities),
    "C every point locked (FIX on points)": pointFix(base.entities),
    "D no constraints": [],
  };
  for (const [name, constraints] of Object.entries(variants)) {
    try {
      const r = await osh.addFeature(ctx, { ...plain, name: `Probe ${name[0]}`, constraints });
      const stored = r.feature?.constraints;
      const row = { sent: constraints.length, stored: stored ? stored.length : "not echoed", status: r.featureState?.featureStatus, message: r.featureState?.statusMessage || r.featureState?.inferredMessage || "" };
      report[name] = { ...row, storedSummary: summarize(stored), featureState: r.featureState };
      console.log(`\n${name}\n  sent ${row.sent}, Onshape kept ${row.stored}, status ${row.status}${row.message ? " (" + row.message + ")" : ""}`);
    } catch (e) {
      report[name] = { error: e.message };
      console.log(`\n${name}\n  REJECTED: ${e.message.slice(0, 200)}`);
    }
  }
  const back = (await osh.getFeatures(ctx)).features || [];
  console.log("\nRead back from the document:");
  for (const f of back.filter((x) => x.featureType === "newSketch")) console.log(`  ${f.name}: ${f.constraints?.length ?? 0} constraints stored`);
  report.readBack = back.filter((x) => x.featureType === "newSketch").map((f) => ({ name: f.name, constraints: f.constraints }));
  console.log("\nNow open the scratch document and look at the four sketches: tell me which ones are black (fully defined) and which are blue.");
}

// One sketch per shape type using the real ClaudeShape constraints, to check each comes out black (fully defined).
async function shapes() {
  const ctx = await createDocumentWithStudio(osh, "ClaudeShape shape check (delete me)");
  console.log("Scratch document:", `https://cad.onshape.com/documents/${ctx.did}/w/${ctx.wid}/e/${ctx.eid}`);
  const round = { type: "path", close: true, start: [5, 0], segments: [{ to: [35, 0] }, { to: [40, 5], radius: 5 }, { to: [40, 15] }, { to: [35, 20], radius: 5 }, { to: [5, 20] }, { to: [0, 15], radius: 5 }, { to: [0, 5] }, { to: [5, 0], radius: 5 }] };
  const cases = {
    "1 rectangle + circle": [{ type: "rectangle", width: 60, height: 40 }, { type: "circle", cx: 30, cy: 20, r: 5 }],
    "2 slot": [{ type: "slot", length: 18, width: 9, cx: 20, cy: 10 }],
    "3 polygon (triangle)": [{ type: "polygon", points: [[0, 0], [30, 0], [0, 20]] }],
    "4 hexagon": [{ type: "regular_polygon", sides: 6, r: 15, cx: 20, cy: 20 }],
    "5 rounded rectangle (path)": [round],
    "6 arc": [{ type: "arc", r: 20, start_deg: 0, end_deg: 120 }],
    "7 text HELLO": [{ type: "text", text: "HELLO", height: 10 }],
  };
  for (const [name, sh] of Object.entries(cases)) {
    try {
      const f = buildSketch({ plane: "top", shapes: sh }); const { _label, ...clean } = f;
      const r = await osh.addFeature(ctx, { ...clean, name });
      console.log(`${name}: sent ${f.constraints.length}, kept ${r.feature?.constraints?.length ?? "?"}, status ${r.featureState?.featureStatus}`);
      report[name] = { sent: f.constraints.length, kept: r.feature?.constraints?.length, status: r.featureState?.featureStatus, message: r.featureState?.statusMessage };
    } catch (e) { console.log(`${name}: REJECTED ${e.message.slice(0, 150)}`); report[name] = { error: e.message }; }
  }
  console.log("\nOpen the document: which of the 7 sketches are blue (not fully defined)? Black = fully defined.");
}

const i = process.argv.indexOf("--dump");
try { await (i > 0 ? dump(process.argv[i + 1]) : process.argv.includes("--shapes") ? shapes() : probe()); }
catch (e) { console.error("Probe failed:", e.message); report.error = e.message; }
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n(full details saved to ${OUT})`);
