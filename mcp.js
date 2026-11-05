#!/usr/bin/env node
// ClaudeShape MCP server: gives Claude (Claude Code / Claude Desktop) CAD tools backed by the Onshape API.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Onshape } from "./lib/onshape.js";
import { tools, runTool, DESIGN_RULES, timedOs, takeTimings } from "./lib/agent.js";
import fs from "node:fs";
import os_ from "node:os";
import path from "node:path";
import { loadKeys } from "./lib/config.js";
import { BASE, urlOf, createDocumentWithStudio, takePending, saveCtx, loadCtx } from "./lib/doc.js";

const LOG = path.join(os_.homedir(), ".claudeshape-timing.log");
function logTiming(tool, total, calls) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200_000) fs.writeFileSync(LOG, "");
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${tool} total=${total}ms ${calls.map((c) => `${c.call}=${c.ms}`).join(" ")}\n`);
  } catch {}
}

let ctx = loadCtx(); // current {did, wid, eid}; shared with the other Claude worker through a small file
const setCtx = (c) => { ctx = c; saveCtx(c); };

const parseUrl = (u) => {
  const m = String(u).match(/documents\/([0-9a-f]+)\/(?:w|v|m)\/([0-9a-f]+)\/e\/([0-9a-f]+)/i);
  return m ? { did: m[1], wid: m[2], eid: m[3] } : null;
};

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

const guide = `ClaudeShape CAD tools (Onshape). Units are mm. Typical flow: new_document -> create_sketch -> extrude/revolve -> fillet/pattern. Check each result's status and call get_bounding_box when done. Give the user the Onshape URL at the end.\n\n${DESIGN_RULES}`;

const server = new Server({ name: "claudeshape", version: "0.2.0" }, { capabilities: { tools: {} }, instructions: guide });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...intro, ...tools].map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input = {} } = req.params;
  const t0 = Date.now();
  { const cur = loadCtx(); if (cur) ctx = cur; }                 // the other Claude worker may have switched document
  const ms = () => {                                              // lets the window show how long Onshape took
    const calls = takeTimings(), total = Date.now() - t0, slow = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { ms: 0 });
    logTiming(name, total, calls);
    return { onshape_ms: total, ...(slow.ms >= 1500 ? { slowest: `${slow.call} ${Math.round(slow.ms / 1000)}s` } : {}) };
  };
  const reply = (o, isError) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(Array.isArray(o) ? { items: o, ...ms() } : { ...o, ...ms() }) }], isError });
  const keys = loadKeys();
  if (!keys) return reply("ClaudeShape has no Onshape API keys yet. Ask the user to run `npm run setup` in the ClaudeShape folder (one-time, 1 minute).", true);
  const os = timedOs(new Onshape(keys));
  try {
    if (name === "list_documents") {
      const r = await os.listDocuments(input.query);
      return reply((r.items || []).map((d) => ({ name: d.name, url: `${BASE}/documents/${d.id}`, id: d.id })));
    }
    const createDoc = async (docName) => {
      // the window usually has one ready already (created while Claude was thinking)
      const ready = await takePending();
      if (ready) { setCtx(ready); os.renameDocument(ready.did, docName).catch(() => {}); return urlOf(ctx); }
      setCtx(await createDocumentWithStudio(os, docName));
      return urlOf(ctx);
    };
    if (name === "new_document") return reply({ url: await createDoc(input.name), message: "Document ready. Open the URL to watch it build." });
    if (name === "open_document") {
      const c = parseUrl(input.url);
      if (!c) return reply("Could not parse that URL. It should look like https://cad.onshape.com/documents/<id>/w/<id>/e/<id>", true);
      setCtx(c);
      return reply({ url: urlOf(ctx) });
    }
    let url;
    if (name === "build_steps" && input.new_document) url = await createDoc(input.new_document);   // one call: new doc + build
    if (!ctx) return reply("No document selected. Call new_document (or open_document) first.", true);
    const out = await runTool(os, ctx, name, input);
    if (out && out._image) {
      const { _image, ...rest } = out;
      return { content: [{ type: "text", text: JSON.stringify({ ...(url ? { url } : {}), ...rest, ...ms() }) }, { type: "image", data: _image.data, mimeType: _image.mimeType }] };
    }
    return reply(url ? { url, ...out } : out);
  } catch (e) {
    return reply(`Error: ${e.message}`, true);
  }
});

await server.connect(new StdioServerTransport());
