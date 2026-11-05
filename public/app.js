const q = new URLSearchParams(location.search);
const ctx = { documentId: q.get("documentId"), workspaceId: q.get("workspaceId"), elementId: q.get("elementId") };
const $ = (id) => document.getElementById(id);
const log = $("log"), form = $("f"), prompt_ = $("p"), go = $("go");

function add(cls, text) {
  $("empty")?.remove();
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

async function init() {
  const s = await (await fetch("/api/status")).json();
  $("ctx").textContent = ctx.elementId ? "Part Studio connected" : "No Part Studio context";
  const b = $("banner");
  const warn = [];
  if (!s.anthropic) warn.push("Server is missing ANTHROPIC_API_KEY.");
  if (!ctx.elementId) warn.push("Open this app from a Part Studio tab in an Onshape document.");
  if (!s.signedIn) {
    const rt = encodeURIComponent(location.pathname + location.search);
    warn.push(`<a href="/oauth/login?returnTo=${rt}" target="_top">Sign in to Onshape</a> to let Claude edit this document.`);
  }
  if (warn.length) { b.innerHTML = warn.join(" "); b.style.display = "block"; }
}

document.querySelectorAll(".chips button").forEach((c) => c.onclick = () => { prompt_.value = c.textContent; prompt_.focus(); });
prompt_.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

form.onsubmit = async (e) => {
  e.preventDefault();
  const text = prompt_.value.trim();
  if (!text) return;
  prompt_.value = "";
  go.disabled = true;
  add("me", text);
  try {
    const res = await fetch("/api/prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text, ...ctx }),
    });
    if (!res.ok) { add("tool err", (await res.json()).error || res.statusText); return; }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (ev.type === "text") add("", ev.text);
        else if (ev.type === "tool") add("tool", `→ ${ev.name} ${JSON.stringify(ev.input)}`);
        else if (ev.type === "result") add(ev.error || ev.output?.status === "ERROR" ? "tool err" : "tool", `  ${ev.error ? "✗ " + ev.error : "✓ " + JSON.stringify(ev.output)}`);
        else if (ev.type === "error") add("tool err", ev.message);
      }
    }
  } catch (err) {
    add("tool err", err.message);
  } finally {
    go.disabled = false;
    prompt_.focus();
  }
};
init();
