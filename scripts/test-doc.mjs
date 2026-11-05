import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.CLAUDESHAPE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "doc-"));
const { precreate, takePending, clearAll, saveCtx, loadCtx } = await import("../lib/doc.js");

let created = 0;
const fake = (delay = 0) => ({
  createDocument: async () => { created++; await new Promise((r) => setTimeout(r, delay)); return { id: "D", defaultWorkspace: { id: "W" } }; },
  getWorkspaceElements: async () => [{ id: "E", elementType: "PARTSTUDIO" }],
  createPartStudio: async () => ({}),
});

assert.equal(await takePending(300), null);                                  // nothing pending, nothing being made

await precreate(fake());                                                      // made ahead of time -> handed over once
assert.deepEqual(await takePending(300), { did: "D", wid: "W", eid: "E" });
assert.equal(await takePending(300), null);                                  // already taken

const slow = precreate(fake(400));                                           // still being made -> the taker waits for it
await new Promise((r) => setTimeout(r, 50));
const t0 = Date.now();
assert.deepEqual(await takePending(3000), { did: "D", wid: "W", eid: "E" });
assert.ok(Date.now() - t0 >= 250, "should have waited for the document");
await slow;

await precreate({ createDocument: async () => { throw new Error("offline"); } });   // failure never throws, taker gives up quickly
assert.equal(await takePending(300), null);

saveCtx({ did: "a", wid: "b", eid: "c" });                                   // shared between the Fast and Review workers
assert.deepEqual(loadCtx(), { did: "a", wid: "b", eid: "c" });
clearAll(); assert.equal(loadCtx(), null);
console.log("doc handover tests passed");
