// MCP smoke test against a fake Onshape server.
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const seen = [];
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/api/v10/documents") return res.end(JSON.stringify({ id: "aaa", defaultWorkspace: { id: "bbb" } }));
    if (req.url.endsWith("/elements")) return res.end(JSON.stringify([{ id: "ccc", elementType: "PARTSTUDIO" }]));
    if (req.method === "POST" && req.url.endsWith("/features")) return res.end(JSON.stringify({ feature: { featureId: "F1", name: "x" }, featureState: { featureStatus: "OK" } }));
    if (req.url.includes("/shadedviews")) return res.end(JSON.stringify({ images: ["iVBORw0KGgo="] }));
    res.end("{}");
  });
}).listen(4201);

const client = new Client({ name: "t", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["mcp.js"],
  env: { ...process.env, ONSHAPE_BASE_URL: "http://localhost:4201", ONSHAPE_ACCESS_KEY: "a", ONSHAPE_SECRET_KEY: "s" },
}));
const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of ["new_document", "create_sketch", "extrude", "revolve", "linear_pattern", "find_faces"]) assert.ok(names.includes(n), n);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

assert.match(await call("create_sketch", { plane: "top", shapes: [] }), /No document selected/);
assert.match(await call("new_document", { name: "Plate" }), /documents\/aaa\/w\/bbb\/e\/ccc/);
assert.match(await call("create_sketch", { plane: "top", shapes: [{ type: "circle", r: 5 }] }), /"featureId":"F1"/);
assert.match(await call("open_document", { url: "https://cad.onshape.com/documents/1a2b/w/3c4d/e/5e6f" }), /1a2b/);
const pv = await client.callTool({ name: "preview", arguments: { view: "iso" } });
const img = pv.content.find((c) => c.type === "image"); assert.ok(img); assert.equal(img.mimeType, "image/png");
assert.ok(seen.some((u) => u.includes("shadedviews?viewMatrix=")));
// one call: new document + build + preview
seen.length = 0;
const one = await client.callTool({ name: "build_steps", arguments: { new_document: "Plate", preview: true, steps: [
  { tool: "create_sketch", as: "s", input: { plane: "top", shapes: [{ type: "rectangle", width: 60, height: 40 }] } },
  { tool: "extrude", input: { sketch_id: "$s", depth: 10, round: { size: 2 } } }] } });
assert.equal(one.content[0].type, "text"); assert.match(one.content[0].text, /documents\/aaa\/w\/bbb\/e\/ccc/); assert.match(one.content[0].text, /bounding_box/);
assert.equal(one.content[1].type, "image");
assert.ok(seen[0].startsWith("POST /api/v10/documents"));
console.log("mcp smoke passed:", names.length, "tools");
await client.close(); fake.close();
