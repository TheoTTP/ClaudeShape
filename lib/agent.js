import Anthropic from "@anthropic-ai/sdk";
import {
  buildSketch, revolveFlip, buildExtrude, applyFeatureChanges, parseColor, partIdsForFeature, stylePart, COLOR_NAMES, buildEdgeFeature, buildOffsetPlane, buildRevolve, buildShell, buildMirror, buildSweep, buildLoft,
  buildLinearPattern, buildCircularPattern, helperAxisPlan, planarFaces,
} from "./onshape.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

export const DESIGN_RULES = `Design quality (follow these every time; a part that is merely correct is not enough):
- Think before building: pick sensible real-world dimensions and keep a clear plan of parts, walls and clearances.
- Make it look designed: round the outer edges of EVERY main body by passing round:{size} on the extrude (about 2 mm, up to 4-5 mm on big boxes, never more than a third of the thinnest wall) BEFORE cutting pockets. Never leave a razor-sharp block when a rounded one is natural; add chamfer/fillet to rims and bottoms too when it suits the part.
- Printable and strong: walls 2-3 mm, floors 2-3 mm, 0.3-0.5 mm clearance on parts that slide or nest, no features thinner than 1.2 mm.
- Cuts must be intentional: a pocket stops short of the far wall (blind depth), a slot never breaks through a wall by accident, and sliding parts get a back stop plus a finger notch or front lip.
- Everything must fit: check interior sizes against the contents (e.g. a Commander deck sleeved is about 68 x 94 mm, 45 mm per 50 cards) and that stacked parts do not overlap or float.
- If build_steps returns problems, a feature failed to regenerate in Onshape: fix or rebuild it (delete_feature, then redo it simpler) before answering, and say so in one short line if you could not.
- Pick the Onshape feature that fits the shape: extrude for prismatic parts; revolve for anything turned or round (knobs, bottles, pulleys, vases); loft (loft_sections) to blend between different shapes or sizes (funnels, tapers, ergonomic handles); sweep a profile along a path for pipes, rails and rims; shell to hollow a solid (cups, hollow bodies; for boxes the hollow macros are simpler); mirror to model half of a symmetric part; linear/circular patterns for repeats; fillet/chamfer for edges. If a feature errors, fall back to extrude/revolve rather than retrying it.
- Mechanisms and assemblies (robot parts, machines, anything with more than one physical piece): model EACH piece as its own body (operation "new"; never "add" a roller, shaft or plate into another part, or they fuse into one useless solid), place every piece at its assembled position with realistic clearances (hole = shaft + 0.2-0.4 mm), then name and colour each one by role with style_part (different colours per role). Search the web for the real sizes of standard components first (shafts, bearings, tube, plate stock, motors, fasteners). Build the real structure of the thing (frame/plates with bearing holes and lightening pockets, rollers or wheels with hubs, shafts, mounts), not just plates and rods, and say in one short line what you simplified.
- Replicas, props and "exact" requests (a named object, a character's weapon, a product): do the work properly and do not stop at a plain shape. First get the reference: use the picture(s) the user attached; otherwise search the web for dimensions, proportions and colours, and if you cannot get enough detail say so and ask the user to attach a photo. Then list the real sections/parts (for a hilt: pommel, grip with ribs or rings, collars, emitter, guards or arms), size them from the reference, and build each with the right tool: bend_tube for anything curved with changing thickness, revolve for straight turned parts, loft/sweep for blends and curves, boxes and cutouts for panels and buttons. Colour every part to match the reference with style_part. Use several build_steps calls if needed and check the preview against the reference, refining at least once. Give every guard, blade-holder or fin real thickness (extrude at least 2 mm, symmetric) and round it, never a flat paper-thin shard. Never present a plain tube or block as the finished replica; if some detail is beyond the tools, finish everything else and name the missing detail in one line.
- Switching a body between its own part and merged is edit_feature operation new/add: use it when the user wants parts joined or separated, or when a merged feature must be coloured on its own.
- Never ask the user to finish or fix anything by hand in Onshape. If a tool fails, retry once a different way (for colours: list_parts, then style_part with part_id); if it still fails, say in one plain line what could not be done and why, with Onshape's reason.
- Keep functional designs simple and clean: a plain, correct design beats an ambitious broken one (replicas and props are the exception: see above). Never remove a whole wall or face (use a thumb notch of at most a quarter of the wall width); for lids use the enclosure macro (friction-fit lip) instead of inventing sliding rails; for two-part cases put the parts SIDE BY SIDE as separate bodies, never overlapping. If a mechanism (hinge, slide, snap) is beyond the tools, choose the simplest printable alternative and say so in one short line.
- Ports and vents: use the cutout macro on the front/left/bottom faces (no extra planes); size ports from the datasheet plus 0.5 mm clearance, and keep vents as tidy repeated slots, not random holes.
- Keep the feature tree tidy: give features meaningful names, avoid offset_plane unless needed and reuse planes instead of making new ones, sketch on origin planes where you can.
- Speed: Onshape edits run one at a time and every edit regenerates the whole feature tree, so each extra feature slows everything after it. Put every profile that shares a plane and depth in ONE sketch and ONE extrude (holes, text and bosses together), and use one fillet per edge group.
- Build once, then look at the picture build_steps returns. If something is clearly wrong (a whole wall missing, parts overlapping or floating, wrong size, sharp edges), fix it once with a small follow-up; otherwise answer straight away. Never loop more than once.
- Be terse, because writing text is the slowest thing you do. Do NOT explain your plan before building: go straight to the tool call. The final answer is at most two short plain lines (overall size and anything the user must know, plus the Onshape link unless told the window shows it). No headings, no bullet lists, no recap of the steps.`;

const SYSTEM = `You are ClaudeShape, a CAD engineer driving Onshape through its REST API.
The user describes a part in plain language; you build it in their current Part Studio using the tools.

Rules:
- Units are millimetres. Sketch coordinates are 2D on the chosen plane. top: x=X, y=Y, extrudes toward +Z. front: x=X, y=Z, extrudes toward -Y. right: x=Y, y=Z, extrudes toward +X. Verify orientation with get_bounding_box when it matters.
- Prefer the box/cylinder/holes macros inside build_steps wherever they fit; they are far shorter than sketch+extrude+round steps.
- Efficiency: for a new part make ONE build_steps call with new_document set to a short name, then answer. Do the whole build in that one call whenever you know the steps (name steps with "as", then reuse them as $name). Use single tools only to fix a failure or make small follow-up edits. Skip get_bounding_box when build_steps already returned it.
- Workflow: create_sketch -> extrude (operation "new" for the first body, "add" to join, "remove" to cut). Every tool result returns a feature id; pass sketch ids to extrude, extrude ids to fillet/chamfer.
- Use "remove" extrudes (with the sketch on the same plane, symmetric or reverse direction as needed) for holes, pockets and cuts. For features at another height make an offset plane first and sketch on "feature:<planeId>".
- Revolve: sketch the profile on one side of a construction line (shape type "line" with construction:true and an id, e.g. "axis"), then call revolve with that sketch_id and axis_entity_id.
- Arcs: use shape "arc" for open arcs, or "path" for connected lines+arcs (rounded corners, D-shapes, teardrops). Prefer fillet for simple edge rounding.
- Sketching on an existing face: call find_faces, choose the face by its normal/origin, then create_sketch with plane "face:<faceId>". Sketch x/y orientation on a face is not guaranteed, so for anything position-sensitive prefer offset_plane + a standard plane, or verify with get_bounding_box.
- Patterns: linear_pattern / circular_pattern repeat a feature. Use kind "feature" to repeat a cut/hole feature, "part" (default) to copy the bodies a feature created. Axes are given as x|y|z plus a point the axis passes through.
- Lettering: use the "text" shape (real font outlines), never draw letters by hand with polygons. Raised text = extrude "add" from the surface plane; engraved = "remove". Text on the top plane reads correctly viewed from above. Use height >= 5 mm, bold for printable text, and put the text in its own sketch so its letters extrude on their own.
- Prefer few, clean features.
${DESIGN_RULES} Choose sensible dimensions when the user gives none, and say which you chose.
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
        round: { type: "object", description: "also fillet the new body's edges in the same step: {size mm, edges?: all|vertical|horizontal}. Use on every main body (new/add).", properties: { size: { type: "number" }, edges: { type: "string", enum: ["all", "vertical", "horizontal"] } }, required: ["size"] },
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
      properties: { name: { type: "string" }, feature_id: { type: "string" }, size: { type: "number", description: "radius mm" }, edges: { type: "string", enum: ["all", "vertical", "horizontal"], description: "which of the feature's edges (default all)" } },
      required: ["feature_id", "size"],
    },
  },
  {
    name: "chamfer",
    description: "Chamfer every edge created by a feature.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, feature_id: { type: "string" }, size: { type: "number", description: "mm" }, edges: { type: "string", enum: ["all", "vertical", "horizontal"] } },
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
    name: "shell",
    description: "Hollow out a solid made by an extrude: removes its top and/or bottom face and leaves walls of the given thickness. Do it right after the extrude (before cuts).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, feature_id: { type: "string", description: "the extrude that made the solid" }, thickness: { type: "number", description: "wall thickness mm" }, open: { type: "string", enum: ["top", "bottom", "both"], description: "which end face to remove (default top)" } },
      required: ["feature_id", "thickness"],
    },
  },
  {
    name: "mirror",
    description: "Mirror the bodies a feature created across the top, front or right plane (model half of a symmetric part, then mirror).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, feature_id: { type: "string" }, plane: { type: "string", enum: ["top", "front", "right"] } },
      required: ["feature_id", "plane"],
    },
  },
  {
    name: "sweep",
    description: "Sweep the closed profile in one sketch along the path drawn in another sketch (pipes, rails, handles, rims). The path sketch can hold lines/arcs; the profile must be on a plane at the path start.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, profile_sketch_id: { type: "string" }, path_sketch_id: { type: "string" }, operation: { type: "string", enum: ["new", "add", "remove", "intersect"] } },
      required: ["profile_sketch_id", "path_sketch_id"],
    },
  },
  {
    name: "loft",
    description: "Blend smoothly through 2+ profile sketches on different planes (funnels, vases, ergonomic handles, shape transitions). Prefer the loft macro inside build_steps, which also makes the planes and sketches.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, sketch_ids: { type: "array", items: { type: "string" }, description: "sketches in order" }, operation: { type: "string", enum: ["new", "add", "remove", "intersect"] } },
      required: ["sketch_ids"],
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
    name: "edit_feature",
    description: "Change a feature you already made, in place. Most useful: flip an extrude/revolve/loft/sweep between operation new (its own separate part) and add (merged into the parts it touches), or remove/intersect; also depth (mm), direction (normal/reverse/symmetric), name, suppressed, or any enum/length/boolean parameter by id via parameters. Later features update automatically.",
    input_schema: {
      type: "object",
      properties: {
        feature_id: { type: "string" },
        operation: { type: "string", enum: ["new", "add", "remove", "intersect"] },
        depth: { type: "number", description: "mm" },
        direction: { type: "string", enum: ["normal", "reverse", "symmetric"] },
        name: { type: "string" }, suppressed: { type: "boolean" },
        parameters: { type: "object", description: "raw parameter edits, e.g. {\"endBound\": \"SYMMETRIC\", \"depth\": 12}" },
      },
      required: ["feature_id"],
    },
  },
  {
    name: "list_parts",
    description: "List the parts in the Part Studio: id, name, colour. Use it to find a part id for style_part when a feature id does not resolve.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "style_part",
    description: "Name and/or colour the part(s) a feature created (use the id of an extrude/revolve/loft/sweep/mirror). Colour = a name (red, green, blue, yellow, orange, purple, pink, black, white, gray, silver, brown, cyan, teal, gold, navy, aluminum, steel) or hex like #ff8800. Always name and colour the parts of a multi-part design by role.",
    input_schema: {
      type: "object",
      properties: { feature_id: { type: "string" }, part_id: { type: "string", description: "alternative to feature_id: a part id from list_parts" }, name: { type: "string", description: "part name, e.g. Roller shaft" }, color: { type: "string" }, opacity: { type: "number", description: "0-1, default 1" } },
      required: [],
    },
  },
  {
    name: "find_faces",
    description: "List planar faces of existing parts (id, unit normal, a point on the face in mm) so you can sketch on one with plane \"face:<id>\".",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "build_steps",
    description: "Run several steps in ONE call (much faster/cheaper than one call per step). Each step is {tool, input, as?}. Name a step with `as`, then use that name in later steps as $name wherever a feature id is needed (sketch_id, feature_id, \"feature:$name\" planes). Stops at the first error and returns what was built; on success also returns the bounding box. Allowed tools: create_sketch, extrude, revolve, offset_plane, fillet, chamfer, linear_pattern, circular_pattern, delete_feature, plus bend_tube{radius?(bend radius mm, default 600),sections:[{length,r,name?,color?}],max_step_deg?,name?} (a smoothly curved tube whose thickness changes section by section: hilts, handles, horns, pipes with collars. It starts at the origin heading up (+Z) and bends toward +X, in the XZ plane; add short wider sections for rings and collars. Built from short tilted cylinders joined by spheres; each section is one part so it can be named and coloured),  shell, mirror, sweep, loft, style_part (name + colour the parts a feature made), edit_feature (change an existing feature, e.g. flip new<->add), plus MACROS that expand to several features and are much shorter to write: loft_sections{sections:[{z,shapes}],operation?,name?} (a loft through sketches at different heights, planes made for you), box{width,depth,height,x?,y?,round?,hollow?:{wall,floor?},name?,operation?} (x/y = lower-left corner on the top plane, z up from 0; hollow = open top), cylinder{r,height,cx?,cy?,round?,hollow?:{wall,floor?}}, holes{d, at:[[x,y],...] or grid:{nx,ny,dx,dy,x0?,y0?}, depth?} (cuts upward from z=0; depth defaults 200), enclosure{width,depth,height,wall?,floor?,round?,lid?:{thickness?,lip?,clearance?,gap?},thumb_notch?,name?} (hollow base at the origin corner + a matching lip lid beside it, ready to print), cutout{face:front|left|bottom, a,b (lower-left corner in that face's 2D coords: front=(x,z), left=(y,z), bottom=(x,y)), w,h, depth? (default 3, through one wall), repeat?:{na,da,nb,db} for vent rows/grids, slot?:true for rounded vent slots} for port holes and vents in the walls of box/enclosure parts (needs no extra planes).",
    input_schema: {
      type: "object",
      properties: {
        new_document: { type: "string", description: "name of a NEW Onshape document to create first (omit to keep working in the current one)" },
        preview: { type: "boolean", description: "return a picture of the result (default true; pass false only for trivial parts)" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { tool: { type: "string" }, input: { type: "object" }, as: { type: "string", description: "alias, letters/digits/underscore" } },
            required: ["tool", "input"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "preview",
    description: "Render a picture of the part studio so you can check your own work. views: iso (default), top, front, right, back, bottom. Call once at the end of a build.",
    input_schema: { type: "object", properties: { view: { type: "string", enum: ["iso", "top", "front", "right", "back", "bottom"] } } },
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

// ---- where did the time go? every Onshape call is timed; the MCP server logs it and reports the slowest ----
const timings = [];
export const takeTimings = () => timings.splice(0);
export function timedOs(osh) {
  return new Proxy(osh, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== "function") return v;
      return async (...a) => {
        const t0 = Date.now();
        try { return await v.apply(target, a); }
        finally { timings.push({ call: key === "addFeature" ? `add ${a[1]?.featureType || "feature"}` : String(key), ms: Date.now() - t0 }); }
      };
    },
  });
}

// Did the solver leave every drawn shape where we put it? (A wrong dimension would drag geometry somewhere else.)
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-7;
export function entitiesMatch(sent, stored) {
  for (const e of sent) {
    const t = (stored || []).find((x) => x.entityId === e.entityId);
    if (!t) return false;
    if (e.geometry) {
      const g = e.geometry, h = t.geometry;
      if (!h) return false;
      const keys = String(g.btType).includes("Line") ? ["pntX", "pntY", "dirX", "dirY"] : ["xCenter", "yCenter", "radius"];
      if (!keys.every((k) => near(g[k], h[k]))) return false;
      if (e.startParam !== undefined && !(near(e.startParam, t.startParam) && near(e.endParam, t.endParam))) return false;
    } else if (!(near(e.x, t.x) && near(e.y, t.y))) return false;   // a sketch point
  }
  return true;
}
async function solvedUnchanged(os, ctx, id, sent) {
  try {
    const f = ((await os.getFeatures(ctx)).features || []).find((x) => x.featureId === id);
    return !!f && entitiesMatch(sent, f.entities);
  } catch { return false; }
}

// Which parts each feature created. Filled while building (by comparing the parts list before/after), so styling does
// not depend on a FeatureScript lookup.
const partTrack = new Map();
const trackKey = (ctx, fid) => `${ctx.eid}:${fid}`;
const BODY_FEATURES = new Set(["extrude", "revolve", "loft", "sweep", "mirror"]);

const BATCHABLE = new Set(["__check_bend", "create_sketch", "extrude", "revolve", "shell", "mirror", "sweep", "loft", "style_part", "edit_feature", "offset_plane", "fillet", "chamfer", "linear_pattern", "circular_pattern", "delete_feature"]);

// replace $alias (defined by earlier steps) inside any string of the input
function subst(v, ids) {
  if (typeof v === "string") return v.replace(/\$([A-Za-z0-9_]+)/g, (m, k) => (k in ids ? ids[k] : m));
  if (Array.isArray(v)) return v.map((x) => subst(x, ids));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, ids)]));
  return v;
}

// ---- macros: one short step that expands to several features (far fewer tokens for Claude to write) ----
const MACROS = new Set(["box", "cylinder", "holes", "enclosure", "cutout", "loft_sections", "bend_tube"]);
const pos = (v, what) => { if (!(v > 0)) throw new Error(`${what} must be a positive number`); return v; };

export function expandMacro(st, label) {
  const i = st.input || {};
  const id = (n) => `${label}_${n}`.replace(/[^A-Za-z0-9_]/g, "_");
  const ref = (n) => "$" + id(n);
  const steps = [];
  if (st.tool === "box") {
    const x = i.x ?? 0, y = i.y ?? 0, w = pos(i.width, "width"), d = pos(i.depth, "depth"), h = pos(i.height, "height");
    const name = i.name || "Box", rd = i.round > 0 ? i.round : 0, op = i.operation || "new";
    if (!i.hollow) {
      steps.push({ tool: "create_sketch", as: id("sk"), input: { name: `${name} sketch`, plane: "top", shapes: [{ type: "rectangle", x, y, width: w, height: d }] } });
      steps.push({ tool: "extrude", as: st.as, input: { name, sketch_id: ref("sk"), depth: h, operation: op, ...(rd ? { round: { size: rd } } : {}) } });
    } else {
      const wall = i.hollow.wall ?? 2.5, floor = i.hollow.floor ?? wall;
      if (!(wall > 0 && 2 * wall < Math.min(w, d))) throw new Error("hollow.wall is too thick for the box");
      if (!(floor >= 0 && floor < h)) throw new Error("hollow.floor must be less than the height");
      steps.push({ tool: "create_sketch", as: id("sk"), input: { name: `${name} walls sketch`, plane: "top", shapes: [
        { type: "rectangle", x, y, width: w, height: d }, { type: "rectangle", x: x + wall, y: y + wall, width: w - 2 * wall, height: d - 2 * wall }] } });
      steps.push({ tool: "extrude", as: st.as, input: { name: `${name} walls`, sketch_id: ref("sk"), depth: h, operation: op, ...(rd ? { round: { size: rd, edges: "vertical" } } : {}) } });
      if (floor > 0) {
        steps.push({ tool: "create_sketch", as: id("fl"), input: { name: `${name} floor sketch`, plane: "top", shapes: [{ type: "rectangle", x, y, width: w, height: d }] } });
        steps.push({ tool: "extrude", input: { name: `${name} floor`, sketch_id: ref("fl"), depth: floor, operation: "add" } });
      }
    }
  } else if (st.tool === "cylinder") {
    const cx = i.cx ?? 0, cy = i.cy ?? 0, r = pos(i.r, "r"), h = pos(i.height, "height");
    const name = i.name || "Cylinder", rd = i.round > 0 ? i.round : 0;
    if (!i.hollow) {
      steps.push({ tool: "create_sketch", as: id("sk"), input: { name: `${name} sketch`, plane: "top", shapes: [{ type: "circle", cx, cy, r }] } });
      steps.push({ tool: "extrude", as: st.as, input: { name, sketch_id: ref("sk"), depth: h, operation: i.operation || "new", ...(rd ? { round: { size: rd } } : {}) } });
    } else {
      const wall = i.hollow.wall ?? 2.5, floor = i.hollow.floor ?? wall;
      if (!(wall > 0 && wall < r)) throw new Error("hollow.wall is too thick for the cylinder");
      if (!(floor >= 0 && floor < h)) throw new Error("hollow.floor must be less than the height");
      steps.push({ tool: "create_sketch", as: id("sk"), input: { name: `${name} wall sketch`, plane: "top", shapes: [{ type: "circle", cx, cy, r }, { type: "circle", cx, cy, r: r - wall }] } });
      steps.push({ tool: "extrude", as: st.as, input: { name: `${name} wall`, sketch_id: ref("sk"), depth: h, operation: i.operation || "new", ...(rd ? { round: { size: rd } } : {}) } });
      if (floor > 0) {
        steps.push({ tool: "create_sketch", as: id("fl"), input: { name: `${name} floor sketch`, plane: "top", shapes: [{ type: "circle", cx, cy, r }] } });
        steps.push({ tool: "extrude", input: { name: `${name} floor`, sketch_id: ref("fl"), depth: floor, operation: "add" } });
      }
    }
  } else if (st.tool === "holes") {
    const r = pos(i.d, "d") / 2;
    let pts = i.at;
    if (!pts && i.grid) {
      const { nx, ny, dx, dy } = i.grid, x0 = i.grid.x0 ?? 0, y0 = i.grid.y0 ?? 0;
      pos(nx, "grid.nx"); pos(ny, "grid.ny");
      if (nx * ny > 400) throw new Error("grid has too many holes");
      pts = []; for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) pts.push([x0 + a * (dx || 0), y0 + b * (dy || 0)]);
    }
    if (!pts?.length) throw new Error("holes needs at: [[x,y],...] or grid");
    steps.push({ tool: "create_sketch", as: id("sk"), input: { name: "Holes sketch", plane: "top", shapes: pts.map(([cx, cy]) => ({ type: "circle", cx, cy, r })) } });
    steps.push({ tool: "extrude", as: st.as, input: { name: i.name || "Holes", sketch_id: ref("sk"), depth: i.depth ?? 200, operation: "remove" } });
  } else if (st.tool === "bend_tube") {
    // A tube that curves along an arc and changes thickness section by section (hilts, handles, horns, pipes with collars).
    // The centreline starts at the origin heading +Z (up) and curves toward +X, in the Front plane (x, z).
    // method "chain" (default): each section is short straight cylinders (a full 360 degree revolve about a tilted axis, which
    //   works everywhere) laid along the arc and joined by spheres, so it needs no partial-angle revolve.
    // method "revolve": a circle revolved round a bend axis then trimmed; only where partial revolve angles are honoured.
    const secs = i.sections;
    if (!Array.isArray(secs) || !secs.length) throw new Error("bend_tube needs sections: [{length, r, name?, color?}]");
    const R = i.radius ?? 600, name = i.name || "Tube";
    const maxR = Math.max(...secs.map((q) => pos(q.r, "section r")));
    if (!(R > maxR + 6)) throw new Error("bend radius must be larger than the thickest section plus 6 mm");
    const cum = [0]; secs.forEach((q) => cum.push(cum.at(-1) + pos(q.length, "section length")));
    const deg = (len) => (len / R) * (180 / Math.PI);
    if (deg(cum.at(-1)) > 175) throw new Error(`the tube turns ${deg(cum.at(-1)).toFixed(0)} degrees; use a larger bend radius (under 175)`);
    const styleStep = (q, k, firstRef) => (q.color || q.name) && steps.push({ tool: "style_part", input: { feature_id: firstRef, ...(q.name ? { name: `${name} ${q.name}` } : {}), ...(q.color ? { color: q.color } : {}) } });

    if (i.method !== "revolve") {
      const maxStep = i.max_step_deg ?? 4, GAP = 0.05;                       // sections end 0.05 mm short so neighbours never fuse
      const C = (sArc) => [R - R * Math.cos(sArc / R), R * Math.sin(sArc / R)];   // centreline point at arc length sArc, (x, z)
      for (let k = 0; k < secs.length; k++) {
        const q = secs[k], s0 = cum[k], s1 = cum[k + 1] - (k < secs.length - 1 ? GAP : 0), nm = `${name} ${q.name || k + 1}`;
        const nseg = Math.max(1, Math.ceil(deg(s1 - s0) / maxStep));
        let first = null;
        for (let j = 0; j < nseg; j++) {
          const a = s0 + ((s1 - s0) * j) / nseg, b = s0 + ((s1 - s0) * (j + 1)) / nseg;
          const P0 = C(a), P1 = C(b), L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
          const u = [(P1[0] - P0[0]) / L, (P1[1] - P0[1]) / L], n = [u[1], -u[0]];       // n = right of the direction of travel
          const pts = [P0, [P0[0] + q.r * n[0], P0[1] + q.r * n[1]], [P1[0] + q.r * n[0], P1[1] + q.r * n[1]], P1];
          // half of the cylinder's side view; its last edge (P1 -> P0) is the axis it is revolved about (entity e3)
          steps.push({ tool: "create_sketch", as: id(`c${k}_${j}`), input: { name: `${nm} segment ${j + 1} profile`, plane: "front", shapes: [{ type: "polygon", points: pts }] } });
          steps.push({ tool: "revolve", as: id(`v${k}_${j}`), input: { name: `${nm} segment ${j + 1}`, sketch_id: ref(`c${k}_${j}`), axis_entity_id: "e3", angle: 360, operation: j === 0 ? "new" : "add" } });
          if (j === 0) first = ref(`v${k}_${j}`);
          if (j < nseg - 1) {                                                       // sphere at the joint: a half disc revolved about its diameter
            const J = P1, p = [J[0] - q.r * u[0], J[1] - q.r * u[1]], e = [J[0] + q.r * u[0], J[1] + q.r * u[1]];
            steps.push({ tool: "create_sketch", as: id(`j${k}_${j}`), input: { name: `${nm} joint ${j + 1} profile`, plane: "front", shapes: [{ type: "path", close: true, start: p, segments: [{ to: e, radius: q.r }] }] } });
            steps.push({ tool: "revolve", input: { name: `${nm} joint ${j + 1}`, sketch_id: ref(`j${k}_${j}`), axis_entity_id: "e1", angle: 360, operation: "add" } });
          }
        }
        styleStep(q, k, first);
      }
    } else {
      // Built from the far end back so a trim can never touch a section already made.
      const axis = { type: "line", x1: R, y1: (i.flip ?? revolveFlip()) ? 40 : -40, x2: R, y2: (i.flip ?? revolveFlip()) ? -40 : 40, construction: true, id: "axis" };   // flip reverses the turning direction
      for (let k = secs.length - 1; k >= 0; k--) {
        const q = secs[k], a = deg(cum[k]), b = deg(cum[k + 1]), nm = `${name} ${q.name || k + 1}`;
        steps.push({ tool: "create_sketch", as: id(`s${k}`), input: { name: `${nm} profile`, plane: "top", shapes: [{ type: "circle", cx: 0, cy: 0, r: q.r }, axis] } });
        steps.push({ tool: "revolve", as: id(`r${k}`), input: { name: nm, sketch_id: ref(`s${k}`), axis_entity_id: "axis", angle: +b.toFixed(4), operation: "new" } });
        if (k === secs.length - 1) steps.push({ tool: "__check_bend", input: { radius: R } });   // did Onshape really make a partial turn?
        if (a > 1e-6) {
          const m = q.r + 3;
          steps.push({ tool: "create_sketch", as: id(`t${k}`), input: { name: `${nm} trim sketch`, plane: "top", shapes: [{ type: "rectangle", x: -m, y: -m, width: 2 * m, height: 2 * m }, axis] } });
          steps.push({ tool: "revolve", input: { name: `${nm} trim`, sketch_id: ref(`t${k}`), axis_entity_id: "axis", angle: +a.toFixed(4), operation: "remove" } });
        }
        styleStep(q, k, ref(`r${k}`));
      }
    }
  } else if (st.tool === "loft_sections") {
    // sections: [{z, shapes:[...]}] bottom to top. Makes an offset plane + sketch per section, then lofts through them.
    const secs = i.sections;
    if (!Array.isArray(secs) || secs.length < 2) throw new Error("loft_sections needs at least 2 sections");
    const skIds = [];
    secs.forEach((sec, k) => {
      let plane = "top";
      if (Math.abs(sec.z ?? 0) > 1e-9) {
        steps.push({ tool: "offset_plane", as: id(`pl${k}`), input: { name: `${i.name || "Loft"} section ${k + 1} plane`, from_plane: "top", offset: sec.z } });
        plane = "feature:" + ref(`pl${k}`);
      }
      steps.push({ tool: "create_sketch", as: id(`sk${k}`), input: { name: `${i.name || "Loft"} section ${k + 1}`, plane, shapes: sec.shapes } });
      skIds.push(ref(`sk${k}`));
    });
    steps.push({ tool: "loft", as: st.as, input: { name: i.name || "Loft", sketch_ids: skIds, operation: i.operation || "new" } });
  } else if (st.tool === "enclosure") {
    // Base (open-top hollow box) at x 0..width, and its lid BESIDE it at x width+gap.. , both sitting on z=0.
    // The lid is a plate with a lip that drops inside the base wall (friction fit, with clearance).
    const w = pos(i.width, "width"), d = pos(i.depth, "depth"), h = pos(i.height, "height");
    const wall = i.wall ?? 2.5, floor = i.floor ?? wall, rd = i.round > 0 ? i.round : 0;
    const L = i.lid || {}, t = L.thickness ?? 3, lipH = L.lip ?? 4, clr = L.clearance ?? 0.3, lipW = L.lip_wall ?? 1.6, gap = L.gap ?? 10;
    const name = i.name || "Case";
    if (!(2 * wall < Math.min(w, d))) throw new Error("wall is too thick for the enclosure");
    const inset = wall + clr;
    if (!(2 * (inset + lipW) < Math.min(w, d))) throw new Error("lid lip does not fit; make the case larger or the walls thinner");
    const x2 = w + gap;
    // base
    steps.push({ tool: "create_sketch", as: id("b_sk"), input: { name: `${name} base walls sketch`, plane: "top", shapes: [
      { type: "rectangle", x: 0, y: 0, width: w, height: d }, { type: "rectangle", x: wall, y: wall, width: w - 2 * wall, height: d - 2 * wall }] } });
    steps.push({ tool: "extrude", as: st.as, input: { name: `${name} base`, sketch_id: ref("b_sk"), depth: h, operation: "new", ...(rd ? { round: { size: rd, edges: "vertical" } } : {}) } });
    steps.push({ tool: "create_sketch", as: id("b_fl"), input: { name: `${name} base floor sketch`, plane: "top", shapes: [{ type: "rectangle", x: 0, y: 0, width: w, height: d }] } });
    steps.push({ tool: "extrude", input: { name: `${name} base floor`, sketch_id: ref("b_fl"), depth: floor, operation: "add" } });
    // lid: lip ring first (rises from z=0), then the plate across the whole footprint (adds the bottom t of it)
    steps.push({ tool: "create_sketch", as: id("l_sk"), input: { name: `${name} lid lip sketch`, plane: "top", shapes: [
      { type: "rectangle", x: x2 + inset, y: inset, width: w - 2 * inset, height: d - 2 * inset },
      { type: "rectangle", x: x2 + inset + lipW, y: inset + lipW, width: w - 2 * (inset + lipW), height: d - 2 * (inset + lipW) }] } });
    steps.push({ tool: "extrude", input: { name: `${name} lid lip`, sketch_id: ref("l_sk"), depth: t + lipH, operation: "new" } });
    steps.push({ tool: "create_sketch", as: id("l_pl"), input: { name: `${name} lid plate sketch`, plane: "top", shapes: [{ type: "rectangle", x: x2, y: 0, width: w, height: d }] } });
    steps.push({ tool: "extrude", input: { name: `${name} lid plate`, sketch_id: ref("l_pl"), depth: t, operation: "add", ...(rd ? { round: { size: rd, edges: "vertical" } } : {}) } });
    if (i.thumb_notch) {   // finger notch in the front wall of the base (front face is on the Front plane)
      const nw = typeof i.thumb_notch === "number" ? i.thumb_notch : 20;
      steps.push({ tool: "create_sketch", as: id("nt"), input: { name: `${name} notch sketch`, plane: "front", shapes: [{ type: "rectangle", x: w / 2 - nw / 2, y: Math.max(floor + 1, h - 8), width: nw, height: 9 }] } });
      steps.push({ tool: "extrude", input: { name: `${name} finger notch`, sketch_id: ref("nt"), depth: wall + 0.4, operation: "remove", direction: "reverse" } });
    }
  } else if (st.tool === "cutout") {
    // Openings/vents on the three faces that sit on the origin planes (the front y=0, left x=0, bottom z=0 of box/enclosure parts).
    const face = i.face, plane = { front: "front", left: "right", bottom: "top" }[face];
    if (!plane) throw new Error('cutout.face must be "front", "left" or "bottom"');
    const a = i.a ?? 0, b = i.b ?? 0, cw = pos(i.w, "w"), ch = pos(i.h, "h");   // a,b = lower-left corner in the face's 2D sketch coords
    const rep = i.repeat || {}, na = rep.na ?? 1, nb = rep.nb ?? 1, da = rep.da ?? 0, db = rep.db ?? 0;
    if (na * nb > 120) throw new Error("repeat has too many openings");
    const shapes = [];
    for (let p = 0; p < na; p++) for (let q = 0; q < nb; q++) {
      const x0 = a + p * da, y0 = b + q * db;
      if (i.slot && Math.min(cw, ch) > 0 && Math.max(cw, ch) > Math.min(cw, ch)) {
        const horiz = cw >= ch;
        shapes.push({ type: "slot", cx: x0 + cw / 2, cy: y0 + ch / 2, length: horiz ? cw : ch, width: horiz ? ch : cw, angle_deg: horiz ? 0 : 90 });
      } else shapes.push({ type: "rectangle", x: x0, y: y0, width: cw, height: ch });
    }
    steps.push({ tool: "create_sketch", as: id("sk"), input: { name: `${i.name || "Cutout"} sketch`, plane, shapes } });
    steps.push({ tool: "extrude", as: st.as, input: { name: i.name || "Cutout", sketch_id: ref("sk"), depth: i.depth ?? 3, operation: "remove", ...(face === "front" ? { direction: "reverse" } : {}) } });
  }
  return steps;
}

const worse = (a, b) => (a === "ERROR" || b === "ERROR" ? "ERROR" : a === "WARNING" || b === "WARNING" ? "WARNING" : a || b);

async function buildSteps(os, ctx, steps, preview = true) {
  const ids = {}, done = [], sketchOutcomes = [];
  let trackParts = steps.some((x) => x.tool === "style_part");
  const seenParts = new Set();
  const listIds = async () => { const r = await os.getParts(ctx); return (Array.isArray(r) ? r : r.parts || []).map((x) => x.partId); };
  if (trackParts) { try { (await listIds()).forEach((x) => seenParts.add(x)); } catch { /* fall back to lookups */ } }
  for (const [i, st] of steps.entries()) {
    const label = st.as || `${st.tool}#${i + 1}`;
    const isMacro = MACROS.has(st.tool);
    if (!isMacro && !BATCHABLE.has(st.tool)) return { stoppedAt: label, error: `"${st.tool}" can't be used in build_steps`, built: done };
    let sub;
    try { sub = isMacro ? expandMacro(st, label) : [st]; } catch (e) { return { stoppedAt: label, error: e.message, built: done }; }
    if (!trackParts && sub.some((x) => x.tool === "style_part")) {       // a macro that colours its own parts: start tracking now
      trackParts = true;
      try { (await listIds()).forEach((x) => seenParts.add(x)); } catch { /* fall back to lookups */ }
    }
    const entry = { step: label };
    const fids = [];
    for (const sst of sub) {
      let out;
      try { out = await runTool(os, ctx, sst.tool, subst(sst.input, ids)); }
      catch (e) {
        if (sst.tool === "__check_bend") { for (const f of [...fids, ...Object.values(ids)]) await os.deleteFeature(ctx, f).catch(() => {}); return { stoppedAt: label, error: e.message, built: done }; }
        if (sst.tool === "style_part") { entry.warning = `could not style: ${e.message}`; continue; }   // cosmetic: never stop a build for it
        return { stoppedAt: label, error: e.message, built: [...done, entry] };
      }
      if (sst.tool === "style_part" && out.warning) entry.warning = out.warning;
      if (sst.as && out.featureId) ids[sst.as] = out.featureId;
      if (out.featureId) fids.push(out.featureId);
      if (trackParts && out.featureId && BODY_FEATURES.has(sst.tool)) {       // which new part(s) did this make?
        try { const now = await listIds(), fresh = now.filter((x) => !seenParts.has(x)); now.forEach((x) => seenParts.add(x)); partTrack.set(trackKey(ctx, out.featureId), fresh); } catch { /* ignore */ }
      }
      entry.status = worse(entry.status, out.status);
      if (out.message) entry.message = out.message;
      if (out.rounded) entry.rounded = out.rounded;
      if (out.defined) sketchOutcomes.push(out.defined);
      if (out.defined && out.defined !== "fully") entry.defined = out.defined;
      if (out.status && out.status !== "OK" && out.status !== "WARNING") return { stoppedAt: label, error: out.message || out.status, built: [...done, { ...entry, featureIds: fids }] };
    }
    if (isMacro) entry.featureIds = fids; else entry.featureId = fids[0];
    done.push(entry);
  }
  // two independent reads: run them together
  const [bb, pv, st] = await Promise.allSettled([runTool(os, ctx, "get_bounding_box", {}), preview ? runTool(os, ctx, "preview", {}) : Promise.resolve(null), (async () => os.getFeatures(ctx))()]);
  const out = { built: done, bounding_box: bb.status === "fulfilled" ? bb.value : { error: bb.reason?.message } };
  if (sketchOutcomes.length) {
    const fully = sketchOutcomes.filter((d) => d === "fully" || d === "dimensioned").length, none = sketchOutcomes.length - fully;
    const dim = sketchOutcomes.filter((d) => d === "dimensioned").length;
    out.sketches = [fully && `${fully} fully defined${dim ? ` (${dim} with editable dimensions)` : ""}`, none && `${none} NOT defined`].filter(Boolean).join(", ");
  }
  if (st.status === "fulfilled") {
    const states = st.value.featureStates || {}, mine = new Set(done.flatMap((d) => d.featureIds || (d.featureId ? [d.featureId] : [])));
    const problems = (st.value.features || []).filter((f) => mine.has(f.featureId) && states[f.featureId]?.featureStatus === "ERROR")
      .map((f) => ({ feature: f.name, id: f.featureId, error: states[f.featureId]?.statusMessage || states[f.featureId]?.inferredMessage || "failed to regenerate" }));
    if (problems.length) out.problems = problems;
  }
  if (pv.status === "fulfilled" && pv.value) Object.assign(out, pv.value);
  else if (pv.status === "rejected") out.preview_error = pv.reason?.message;
  return out;
}

export async function runTool(os, ctx, name, input) {
  const summarize = (r) => {
    const status = r.featureState?.featureStatus;
    const msg = r.featureState?.statusMessage || r.featureState?.inferredMessage;
    return { featureId: r.feature?.featureId, name: r.feature?.name, status, ...(msg ? { message: msg } : {}) };
  };
  const add = async (feature) => {
    const { _label, _alts, _verify, ...clean } = feature;
    if (clean.btType !== "BTMSketch-151") return summarize(await os.addFeature(ctx, clean));
    if (!clean.constraints?.length) return { ...summarize(await os.addFeature(ctx, clean)), defined: "no (sketch too large to constrain)" };
    // Try, in order: the dimensioned sketch (kept only if Onshape leaves every shape exactly where it was drawn),
    // the same with dimension ends swapped, then anchors locked in place. A rejection never fails the build.
    const attempts = [{ label: _label || "fully", feature: clean, verify: !!_verify },
      ...(_alts || []).map((x) => ({ label: x.label, verify: !!x.verify, feature: { ...clean, entities: x.entities, constraints: x.constraints } }))];
    for (const a of attempts) {
      try {
        const r = await os.addFeature(ctx, a.feature);
        const id = r.feature?.featureId;
        const stored = r.feature?.constraints?.length;           // what Onshape actually kept (undefined = not echoed back)
        let failed = r.featureState?.featureStatus === "ERROR" || stored === 0;
        if (!failed && a.verify && id) failed = !(await solvedUnchanged(os, ctx, id, a.feature.entities));
        else if (!failed && a.feature.constraints.length > 60 && id) {   // heavy sketches (text): the reply can say OK while the solve fails
          try { failed = (await os.getFeatures(ctx)).featureStates?.[id]?.featureStatus === "ERROR"; } catch { /* keep it */ }
        }
        if (!failed) return { ...summarize(r), defined: a.label };
        if (id) await os.deleteFeature(ctx, id).catch(() => {});
      } catch { /* try the next one */ }
    }
    return { ...summarize(await os.addFeature(ctx, { ...clean, constraints: [] })), defined: "no (Onshape rejected the constraints)" };
  };
  switch (name) {
    case "create_sketch": return add(buildSketch(input));
    case "extrude": {
      const out = await add(buildExtrude(input));
      const rd = input.round;
      if (rd?.size > 0 && out.featureId && out.status !== "ERROR" && /^(new|add)$/i.test(input.operation || "new")) {
        for (const size of [rd.size, rd.size / 2]) {      // too-big radius? retry at half
          try {
            const f = await add(buildEdgeFeature("fillet", { name: "Round edges", feature_id: out.featureId, size, edges: rd.edges || "all" }));
            if (f.status !== "ERROR") { out.rounded = `${size} mm ${rd.edges || "all"}`; break; }
            if (f.featureId) await os.deleteFeature(ctx, f.featureId).catch(() => {});
          } catch { /* try smaller */ }
        }
        if (!out.rounded) out.rounded = "skipped (Onshape could not fillet it)";
      }
      return out;
    }
    case "offset_plane": return add(buildOffsetPlane(input));
    case "fillet": return add(buildEdgeFeature("fillet", input));
    case "chamfer": return add(buildEdgeFeature("chamfer", input));
    case "revolve": return add(buildRevolve(input));
    case "edit_feature": {
      const { feature_id, ...changes } = input;
      const feats = (await os.getFeatures(ctx)).features || [];
      const cur = feats.find((f) => f.featureId === feature_id);
      if (!cur) throw new Error(`No feature with id ${feature_id}. Use list_features to see ids`);
      const { feature, changed } = applyFeatureChanges(cur, changes);
      const r = await os.updateFeature(ctx, feature_id, feature);
      partTrack.delete(trackKey(ctx, feature_id));                       // which parts it makes may have changed
      const status = r.featureState?.featureStatus, msg = r.featureState?.statusMessage || r.featureState?.inferredMessage;
      return { featureId: feature_id, changed, status, ...(msg ? { message: msg } : {}) };
    }
    case "list_parts": {
      const parts = await os.getParts(ctx);
      return (Array.isArray(parts) ? parts : parts.parts || []).map((x) => ({ part_id: x.partId, name: x.name, color: x.appearance?.color ? [x.appearance.color.red, x.appearance.color.green, x.appearance.color.blue] : undefined }));
    }
    case "__check_bend": {
      const b = await os.getBoundingBox(ctx), zr = (b.highZ - b.lowZ) * 1000;
      if (zr > 1.5 * input.radius) throw new Error(`Onshape ignored the partial revolve angle and made a full ring about ${(zr).toFixed(0)} mm across. The curved sections were removed. Do not use bend_tube here: build the part straight with revolve (angle 360) instead, and say that the curve could not be made`);
      return { checked: true };
    }
    case "style_part": {
      if (!input.name && !input.color) throw new Error("style_part needs a name and/or a colour");
      if (input.color && !parseColor(input.color)) throw new Error(`Unknown colour "${input.color}". Use one of: ${COLOR_NAMES.join(", ")} or hex like #ff8800`);
      let ids = input.part_id ? [input.part_id] : (partTrack.get(trackKey(ctx, input.feature_id)) || []);
      if (!ids.length && input.feature_id) { try { ids = await partIdsForFeature(os, ctx, input.feature_id); } catch { /* handled below */ } }
      if (!ids.length) throw new Error("Could not tell which part that feature made. If it was merged into another part (operation add) either style that part by id (call list_parts, pass part_id) or make it its own part first with edit_feature operation new. Cuts and fillets make no part");
      const done = [];
      for (const [k, pid] of ids.entries()) {
        const nm = input.name && ids.length > 1 ? `${input.name} ${k + 1}` : input.name;
        done.push(await stylePart(os, ctx, pid, { name: nm, color: input.color, opacity: input.opacity }));
      }
      const bad = done.filter((d) => d.named === false || d.colored === false);
      return { parts: done.length, ...(bad.length ? { warning: "Onshape did not keep the " + [bad.some((d) => d.named === false) && "name", bad.some((d) => d.colored === false) && "colour"].filter(Boolean).join(" and "), reason: bad.find((d) => d.reason)?.reason } : { ok: true }) };
    }
    case "shell": return add(buildShell(input));
    case "mirror": return add(buildMirror(input));
    case "sweep": return add(buildSweep(input));
    case "loft": return add(buildLoft(input));
    case "linear_pattern": {
      const h = await helperAxis(os, ctx, add, input.axis, input.axis_point);
      return add(buildLinearPattern({ ...input, helper_sketch_id: h.sketch, helper_entity_id: h.entity }));
    }
    case "circular_pattern": {
      const h = await helperAxis(os, ctx, add, input.axis, input.axis_point);
      return add(buildCircularPattern({ ...input, helper_sketch_id: h.sketch, helper_entity_id: h.entity }));
    }
    case "find_faces": return planarFaces(await os.getBodyDetails(ctx));
    case "preview": {
      const data = await os.getShadedView(ctx, input.view || "iso");
      return { _image: { data, mimeType: "image/png" }, view: input.view || "iso" };
    }
    case "build_steps": return buildSteps(os, ctx, input.steps || [], input.preview !== false);
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
