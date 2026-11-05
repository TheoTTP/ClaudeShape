import Anthropic from "@anthropic-ai/sdk";
import { buildSketch, buildExtrude, buildEdgeFeature, buildOffsetPlane } from "./onshape.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You are ClaudeShape, a CAD engineer driving Onshape through its REST API.
The user describes a part in plain language; you build it in their current Part Studio using the tools.

Rules:
- Units are millimetres. Sketch coordinates are 2D on the chosen plane. top: x=X, y=Y, extrudes toward +Z. front: x=X, y=Z, extrudes toward -Y. right: x=Y, y=Z, extrudes toward +X. Verify orientation with get_bounding_box when it matters.
- Workflow: create_sketch -> extrude (operation "new" for the first body, "add" to join, "remove" to cut). Every tool result returns a feature id; pass sketch ids to extrude, extrude ids to fillet/chamfer.
- Use "remove" extrudes (with the sketch on the same plane, symmetric or reverse direction as needed) for holes, pockets and cuts. For features at another height make an offset plane first and sketch on "feature:<planeId>".
- Prefer few, clean features. Choose sensible dimensions when the user gives none, and say which you chose.
- After building, call get_bounding_box to sanity-check the size. If any tool returns an error or featureStatus ERROR/WARNING, read the message, fix it (delete_feature then retry) before continuing.
- Finish with a short plain-text summary: what was built and the key dimensions.`;

const tools = [
  {
    name: "create_sketch",
    description: "Create a sketch on a plane containing closed profiles. Dimensions in mm. Overlapping/nested closed shapes make regions (a circle inside a rectangle gives a ring when extruded).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        plane: { type: "string", description: '"top", "front", "right", or "feature:<planeFeatureId>"' },
        shapes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["circle", "rectangle", "polygon", "regular_polygon", "slot"] },
              cx: { type: "number" }, cy: { type: "number" }, r: { type: "number", description: "radius (circle) or circumradius (regular_polygon)" },
              x: { type: "number", description: "rectangle lower-left x" }, y: { type: "number", description: "rectangle lower-left y" },
              width: { type: "number" }, height: { type: "number" }, length: { type: "number" },
              points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[x,y],...] for polygon" },
              sides: { type: "integer" }, rotation_deg: { type: "number" }, angle_deg: { type: "number" },
            },
            required: ["type"],
          },
        },
      },
      required: ["plane", "shapes"],
    },
  },
  {
    name: "extrude",
    description: "Extrude all closed regions of a sketch.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        sketch_id: { type: "string" },
        depth: { type: "number", description: "mm (total length if symmetric)" },
        operation: { type: "string", enum: ["new", "add", "remove", "intersect"] },
        direction: { type: "string", enum: ["normal", "reverse", "symmetric"] },
      },
      required: ["sketch_id", "depth"],
    },
  },
  {
    name: "offset_plane",
    description: "Create a construction plane offset from top/front/right (or another plane) by a distance in mm.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, from_plane: { type: "string" }, offset: { type: "number" } },
      required: ["from_plane", "offset"],
    },
  },
  {
    name: "fillet",
    description: "Fillet every edge created by a feature (e.g. an extrude).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, feature_id: { type: "string" }, size: { type: "number", description: "radius mm" } },
      required: ["feature_id", "size"],
    },
  },
  {
    name: "chamfer",
    description: "Chamfer every edge created by a feature.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, feature_id: { type: "string" }, size: { type: "number", description: "mm" } },
      required: ["feature_id", "size"],
    },
  },
  { name: "list_features", description: "List current features in the Part Studio with ids and status.", input_schema: { type: "object", properties: {} } },
  {
    name: "delete_feature",
    description: "Delete a feature by id (use to undo a failed or wrong step).",
    input_schema: { type: "object", properties: { feature_id: { type: "string" } }, required: ["feature_id"] },
  },
  { name: "get_bounding_box", description: "Bounding box of all parts in mm.", input_schema: { type: "object", properties: {} } },
];

function summarizeFeatures(res) {
  const states = res.featureStates || {};
  return (res.features || []).map((f) => ({
    id: f.featureId, type: f.featureType || f.btType, name: f.name,
    status: states[f.featureId]?.featureStatus,
  }));
}

async function runTool(os, ctx, name, input) {
  const add = async (feature) => {
    const r = await os.addFeature(ctx, feature);
    const status = r.featureState?.featureStatus;
    const msg = r.featureState?.statusMessage || r.featureState?.inferredMessage;
    return { featureId: r.feature?.featureId, name: r.feature?.name, status, ...(msg ? { message: msg } : {}) };
  };
  switch (name) {
    case "create_sketch": return add(buildSketch(input));
    case "extrude": return add(buildExtrude(input));
    case "offset_plane": return add(buildOffsetPlane(input));
    case "fillet": return add(buildEdgeFeature("fillet", input));
    case "chamfer": return add(buildEdgeFeature("chamfer", input));
    case "list_features": return summarizeFeatures(await os.getFeatures(ctx));
    case "delete_feature": await os.deleteFeature(ctx, input.feature_id); return { deleted: input.feature_id };
    case "get_bounding_box": {
      const b = await os.getBoundingBox(ctx);
      const m = (v) => +(v * 1000).toFixed(3);
      return { min_mm: [m(b.lowX), m(b.lowY), m(b.lowZ)], max_mm: [m(b.highX), m(b.highY), m(b.highZ)] };
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

/**
 * Run the agent loop. `emit(event)` is called with {type:"text"|"tool"|"result"|"done"|"error", ...}.
 */
export async function runAgent({ prompt, history = [], os, ctx, emit, signal }) {
  const client = new Anthropic();
  const existing = summarizeFeatures(await os.getFeatures(ctx));
  const messages = [
    ...history,
    { role: "user", content: `Current Part Studio features: ${JSON.stringify(existing)}\n\nRequest: ${prompt}` },
  ];

  for (let turn = 0; turn < 30; turn++) {
    const resp = await client.messages.create(
      { model: MODEL, max_tokens: 4096, system: SYSTEM, tools, messages },
      { signal },
    );
    messages.push({ role: "assistant", content: resp.content });
    for (const b of resp.content) if (b.type === "text" && b.text.trim()) emit({ type: "text", text: b.text });

    const uses = resp.content.filter((b) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !uses.length) {
      emit({ type: "done" });
      return messages;
    }
    const results = [];
    for (const u of uses) {
      emit({ type: "tool", name: u.name, input: u.input });
      try {
        const out = await runTool(os, ctx, u.name, u.input);
        emit({ type: "result", name: u.name, output: out });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        emit({ type: "result", name: u.name, error: e.message });
        results.push({ type: "tool_result", tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  emit({ type: "error", message: "Stopped after 30 steps." });
  return messages;
}
