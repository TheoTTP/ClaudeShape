#!/usr/bin/env node
// ClaudeShape MCP server: gives Claude (Claude Code / Claude Desktop) CAD tools backed by the Onshape API.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Onshape } from "./lib/onshape.js";
import { tools, runTool } from "./lib/agent.js";
import { loadKeys } from "./lib/config.js";

const BASE = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";
let ctx = null; // current {did, wid, eid}

const urlOf = (c) => `${BASE}/documents/${c.did}/w/${c.wid}/e/${c.eid}`;
const parseUrl = (u) => {
  const m = String(u).match(/documents\/([0-9a-f]+)\/(?:w|v|m)\/([0-9a-f]+)\/e\/([0-9a-f]+)/i);
  return m ? { did: m[1], wid: m[2], eid: m[3] } : null;
};

async function ensurePartStudio(os, did, wid) {
  const find = async () => (await os.getWorkspaceElements(did, wid)).find((e) => e.elementType === "PARTSTUDIO" || e.type === "Part Studio");
  let el = await find();
  if (!el) { await os.createPartStudio(did, wid, "Part Studio 1"); el = await find(); }
  if (!el) throw new Error("Could not find or create a Part Studio");
  return el.id;
}

const intro = [
  {
    name: "new_document",
    description: "Create a new Onshape document with a Part Studio and make it the current target. Call this first unless the user gave you an existing document. Returns a URL to show the user.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "open_document",
    description: "Make an existing Onshape Part Studio (pasted URL) the current target.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "list_documents",
    description: "Search the user's Onshape documents by name.",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  },
];

const guide = `ClaudeShape CAD tools (Onshape). Units are mm. Typical flow: new_document -> create_sketch -> extrude/revolve -> fillet/pattern. Check each result's status and call get_bounding_box when done. Give the user the Onshape URL at the end.`;

const server = new Server({ name: "claudeshape", version: "0.2.0" }, { capabilities: { tools: {} }, instructions: guide });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...intro, ...tools].map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input = {} } = req.params;
  const reply = (o, isError) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }], isError });
  const keys = loadKeys();
  if (!keys) return reply("ClaudeShape has no Onshape API keys yet. Ask the user to run `npm run setup` in the ClaudeShape folder (one-time, 1 minute).", true);
  const os = new Onshape(keys);
  try {
    if (name === "list_documents") {
      const r = await os.listDocuments(input.query);
      return reply((r.items || []).map((d) => ({ name: d.name, url: `${BASE}/documents/${d.id}`, id: d.id })));
    }
    if (name === "new_document") {
      const d = await os.createDocument(input.name);
      const wid = d.defaultWorkspace.id;
      ctx = { did: d.id, wid, eid: await ensurePartStudio(os, d.id, wid) };
      return reply({ url: urlOf(ctx), message: "Document ready. Open the URL to watch it build." });
    }
    if (name === "open_document") {
      const c = parseUrl(input.url);
      if (!c) return reply("Could not parse that URL. It should look like https://cad.onshape.com/documents/<id>/w/<id>/e/<id>", true);
      ctx = c;
      return reply({ url: urlOf(ctx) });
    }
    if (!ctx) return reply("No document selected. Call new_document (or open_document) first.", true);
    return reply(await runTool(os, ctx, name, input));
  } catch (e) {
    return reply(`Error: ${e.message}`, true);
  }
});

await server.connect(new StdioServerTransport());
