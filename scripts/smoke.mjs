// End-to-end smoke test with fake Onshape + fake Anthropic servers (no network/keys needed).
import http from "node:http";
import { spawn } from "node:child_process";

const seen = [];
const onshape = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url.endsWith("/features")) return res.end(JSON.stringify({ features: [], featureStates: {} }));
    if (req.method === "POST" && req.url.endsWith("/features")) {
      const f = JSON.parse(b).feature;
      seen.push("  " + f.featureType);
      return res.end(JSON.stringify({ feature: { featureId: "F" + seen.length, name: f.name }, featureState: { featureStatus: "OK" } }));
    }
    res.end(JSON.stringify({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.06, highY: 0.04, highZ: 0.01 }));
  });
}).listen(4101);

let step = 0;
const claude = http.createServer((req, res) => {
  req.resume(); req.on("end", () => {
    const script = [
      [{ type: "tool_use", id: "t1", name: "create_sketch", input: { plane: "top", shapes: [{ type: "rectangle", width: 60, height: 40 }, { type: "slot", cx: 30, cy: 20, length: 20, width: 6 }] } }],
      [{ type: "tool_use", id: "t2", name: "extrude", input: { sketch_id: "F2", depth: 10 } }],
      [{ type: "text", text: "Built a plate." }],
    ][step++];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: script, stop_reason: script[0].type === "tool_use" ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(4102);

const srv = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: "4100", ONSHAPE_BASE_URL: "http://localhost:4101", ANTHROPIC_BASE_URL: "http://localhost:4102",
    ANTHROPIC_API_KEY: "k", ONSHAPE_ACCESS_KEY: "a", ONSHAPE_SECRET_KEY: "s" }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 1000));
const r = await fetch("http://localhost:4100/api/prompt", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "plate", documentId: "d", workspaceId: "w", elementId: "e" }) });
console.log((await r.text()).trim());
console.log(seen.join("\n"));
srv.kill(); onshape.close(); claude.close();
