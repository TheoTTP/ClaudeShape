import Anthropic from "@anthropic-ai/sdk";
import {
  buildSketch, buildExtrude, buildEdgeFeature, buildOffsetPlane, buildRevolve,
  buildLinearPattern, buildCircularPattern, helperAxisPlan, planarFaces,
} from "./onshape.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You are ClaudeShape, a CAD engineer driving Onshape through its REST API.
The user describes a part in plain language; you build it in their current Part Studio using the tools.

Rules:
- Units are millimetres. Sketch coordinates are 2D on the chosen plane. top: x=X, y=Y, extrudes toward +Z. front: x=X, y=Z, extrudes toward -Y. right: x=Y, y=Z, extrudes toward +X. Verify orientation with get_bounding_box when it matters.
- Workflow: create_sketch -> extrude (operation "new" for the first body, "add" to join, "remove" to cut). Every tool result returns a feature id; pass sketch ids to extrude, extrude ids to fillet/chamfer.
- Use "remove" extrudes (with the sketch on the same plane, symmetric or reverse direction as needed) for holes, pockets and cuts. For features at another height make an offset plane first and sketch on "feature:<planeId>".
- Revolve: sketch the profile on one side of a construction line (shape type "line" with construction:true and an id, e.g. "axis"), then call revolve with that sketch_id and axis_entity_id.
- Arcs: use shape "arc" for open arcs, or "path" for connected lines+arcs (rounded corners, D-shapes, teardrops). Prefer fillet for simple edge rounding.
- Sketching on an existing face: call find_faces, choose the face by its normal/origin, then create_sketch with plane "face:<faceId>". Sketch x/y orientation on a face is not guaranteed, so for anything position-sensitive prefer offset_plane + a standard plane, or verify with get_bounding_box.
- Patterns: linear_pattern / circular_pattern repeat a feature. Use kind "feature" to repeat a cut/hole feature, "part" (default) to copy the bodies a feature created. Axes are given as x|y|z plus a point the axis passes through.
- Lettering: use the "text" shape (real font outlines), never draw letters by hand with polygons. Raised text = extrude "add" from the surface plane; engraved = "remove". Text on the top plane reads correctly viewed from above. Use height >= 5 mm, bold for printable text, and put the text in its own sketch so its letters extrude on their own.
- Prefer few, clean features. Choose sensible dimensions when the user gives none, and say which you chose.
- After building, call get_bounding_box to sanity-check the size. If any tool returns an error or featureStatus ERROR/WARNING, read the message, fix it (delete_feature then retry) before continuing.
- Finish with a short plain-text summary: what was built and the key dimensions.`;

export const tools = [
  {
    name: "create_sketch",
    description: "Create a sketch on a plane containing closed profiles. Dimensions in mm. Overlapping/nested closed shapes make regions (a circle inside a rectangle gives a ring when extruded).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        plane: { type: "string", description: '"top", "front", "right", "feature:<planeFeatureId>" or "face:<faceId>" (from find_faces)' },
        shapes: {
          description: "text (text,x,y baseline start,height cap-height mm,bold?,align?) for lettering, circle, rectangle, polygon, regular_polygon, slot, arc (cx,cy,r,start_deg,end_deg CCW), line (x1,y1,x2,y2,construction?,id?), path (start,[segments{to,radius?,clockwise?,large?}],close?)",
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["circle", "rectangle", "polygon", "regular_polygon", "slot", "arc", "line", "path", "text"] },
              cx: { type: "number" }, cy: { type: "number" }, r: { type: "number", description: "radius (circle) or circumradius (regular_polygon)" },
              x: { type: "number", description: "rectangle lower-left x" }, y: { type: "number", description: "rectangle lower-left y" },
              width: { type: "number" }, height: { type: "number" }, length: { type: "number" },
              points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[x,y],...] for polygon" },
              sides: { type: "integer" }, rotation_deg: { type: "number" }, angle_deg: { type: "number" },
              text: { type: "string" }, height: { type: "number", description: "text capital height mm, or rectangle height" }, bold: { type: "boolean" }, align: { type: "string", enum: ["left", "center"] },
              start_deg: { type: "number" }, end_deg: { type: "number" },
              x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
              construction: { type: "boolean" }, id: { type: "string", description: "entity id for lines (needed for revolve axis)" },
              start: { type: "array", items: { type: "number" } }, close: { type: "boolean" },
              segments: { type: "array", items: { type: "object", properties: {
                to: { type: "array", items: { type: "number" } }, radius: { type: "number" },
                clockwise: { type: "boolean" }, large: { type: "boolean", description: "arc > 180 degrees" } }, required: ["to"] } },
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
        include_islands: { type: "boolean", description: "also extrude regions nested inside holes (e.g. a disc inside a ring). Default false: nested shapes make holes." },
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
  {
    name: "revolve",
    description: "Revolve the closed regions of a sketch around a construction line in the same sketch.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, sketch_id: { type: "string" },
        axis_entity_id: { type: "string", description: "id of the construction line shape in that sketch" },
        angle: { type: "number", description: "degrees, default 360" },
        operation: { type: "string", enum: ["new", "add", "remove", "intersect"] },
      },
      required: ["sketch_id", "axis_entity_id"],
    },
  },
  {
    name: "linear_pattern",
    description: "Repeat a feature or its bodies along a world axis.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, feature_id: { type: "string" },
        kind: { type: "string", enum: ["part", "feature"], description: "part = copy bodies created by the feature; feature = repeat the feature itself (holes, cuts)" },
        axis: { type: "string", enum: ["x", "y", "z"] },
        axis_point: { type: "array", items: { type: "number" }, description: "x: [y,z]; y: [x,z]; z: [x,y] — only affects where the direction line sits; default [0,0]" },
        spacing: { type: "number", description: "mm between instances" }, count: { type: "integer", description: "total instances incl. original" },
      },
      required: ["feature_id", "axis", "spacing", "count"],
    },
  },
  {
    name: "circular_pattern",
    description: "Repeat a feature or its bodies around a world-aligned axis.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, feature_id: { type: "string" },
        kind: { type: "string", enum: ["part", "feature"] },
        axis: { type: "string", enum: ["x", "y", "z"] },
        axis_point: { type: "array", items: { type: "number" }, description: "x: [y,z]; y: [x,z]; z: [x,y] — a point the axis passes through; default [0,0]" },
        count: { type: "integer" }, angle: { type: "number", description: "total angle, default 360 (evenly spaced)" },
      },
      required: ["feature_id", "axis", "count"],
    },
  },
  {
    name: "find_faces",
    description: "List planar faces of existing parts (id, unit normal, a point on the face in mm) so you can sketch on one with plane \"face:<id>\".",
    input_schema: { type: "object", properties: {} },
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

// Create the construction line a pattern uses as its direction/axis.
async function helperAxis(os, ctx, add, axis, at) {
  const plan = helperAxisPlan(axis, at);
  let plane = plan.base;
  if (Math.abs(plan.offset) > 1e-9) {
    const p = await add(buildOffsetPlane({ name: "Pattern axis plane", from_plane: plan.base, offset: plan.offset }));
    if (!p.featureId) throw new Error("could not create axis plane");
    plane = `feature:${p.featureId}`;
  }
  const sk = await add(buildSketch({ name: "Pattern axis", plane, shapes: [{ type: "line", ...plan.line, construction: true, id: "axis" }] }));
  if (!sk.featureId) throw new Error("could not create axis sketch");
  return { sketch: sk.featureId, entity: "axis" };
}

export async function runTool(os, ctx, name, input) {
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
    case "revolve": return add(buildRevolve(input));
    case "linear_pattern": {
      const h = await helperAxis(os, ctx, add, input.axis, input.axis_point);
      return add(buildLinearPattern({ ...input, helper_sketch_id: h.sketch, helper_entity_id: h.entity }));
    }
    case "circular_pattern": {
      const h = await helperAxis(os, ctx, add, input.axis, input.axis_point);
      return add(buildCircularPattern({ ...input, helper_sketch_id: h.sketch, helper_entity_id: h.entity }));
    }
    case "find_faces": return planarFaces(await os.getBodyDetails(ctx));
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
export async function runAgent({ prompt, history = [], os, ctx, emit, signal, apiKey }) {
  const client = new Anthropic(apiKey ? { apiKey } : {});
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
