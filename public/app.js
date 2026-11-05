const q = new URLSearchParams(location.search);
const qs = q.toString();
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

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const hdrs = () => ({
  ...(store.get("os_token") && { "x-onshape-token": store.get("os_token") }),
  ...(store.get("anthropic_key") && { "x-anthropic-key": store.get("anthropic_key") }),
});
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { ...hdrs(), ...(opts.headers || {}) } });
  const fresh = r.headers.get("x-refreshed-token");
  if (fresh) store.set("os_token", fresh);
  return r;
};

window.addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data?.claudeshapeToken) { store.set("os_token", e.data.claudeshapeToken); init(); }
});
$("akey").value = store.get("anthropic_key");
$("akey").onchange = () => { store.set("anthropic_key", $("akey").value.trim()); init(); };
$("clear").onclick = (e) => { e.preventDefault(); store.set("os_token", ""); store.set("anthropic_key", ""); $("akey").value = ""; init(); };

async function init() {
  const s = await (await api("/api/status?" + qs)).json();
  $("ctx").textContent = ctx.elementId ? "Part Studio connected" : "No Part Studio context";
  const b = $("banner");
  const todo = [];
  if (!ctx.elementId) todo.push("Open this from a Part Studio tab in an Onshape document.");
  if (!s.signedIn) todo.push(s.oauthConfigured
    ? 'Let Claude edit your documents: <button id="si">Sign in to Onshape</button>'
    : "The server has no Onshape OAuth app configured (see README).");
  if (!s.serverKey && !store.get("anthropic_key")) { todo.push("Paste your Anthropic API key in Settings."); $("settings").open = true; }
  b.innerHTML = todo.join("<br>");
  b.style.display = todo.length ? "block" : "none";
  const si = $("si");
  if (si) si.onclick = () => window.open("/oauth/login", "claudeshape-login", "width=520,height=700");
}

document.querySelectorAll(".chips button").forEach((c) => c.onclick = () => { prompt_.value = c.textContent; prompt_.focus(); });
prompt_.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

form.onsubmit = async (e) => {
  e.preventDefault();
  const text = prompt_.value.trim();
  if (!text || go.disabled) return;
  prompt_.value = "";
  go.disabled = true;
  add("me", text);
  try {
    const res = await api("/api/prompt", {
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
