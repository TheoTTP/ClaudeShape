<img src="public/icon-96.png" align="right" alt="ClaudeShape">

# ClaudeShape

An Onshape app that lets Claude do the CAD. Open it in a Part Studio, type
"a 60×40×10 mm plate with four 5 mm corner holes", and Claude builds it as real,
editable Onshape features (sketches with lines/arcs/slots/paths, extrudes, cuts, revolves, fillets, chamfers, offset planes, linear and circular patterns, sketches on existing faces)
through the Onshape REST API.

```
You ──▶ Claude ──MCP tools──▶ mcp.js ──▶ Onshape REST API (sketch / extrude / revolve / pattern …)
```

Claude reads the current feature list, calls tools, checks each feature's status
(and the part's bounding box), and fixes errors itself before summarising.

## Quick start (no Anthropic key, no server, no `.env`)

```bash
npm install
npm run setup
```

`setup` asks for one Onshape API key pair (<https://dev-portal.onshape.com/keys>, takes a minute),
checks it works, saves it to `~/.claudeshape.json`, and registers ClaudeShape with Claude Code
(`claude mcp add`). It prints the Claude Desktop config line if `claude` isn't installed.

Then just talk to Claude:

> Use ClaudeShape to make a 60×40×10 mm plate with four 5 mm corner holes.

Claude creates a new Onshape document itself, builds the part, and gives you the link.
It uses your existing Claude subscription, so there is no separate API key and nothing to host.

## Install on a Mac or PC (for friends)

Each person needs a **Claude account** (Pro or Max, it uses their own plan) and a free **Onshape account**. Nothing is shared between people: keys stay on each person's computer.

**Mac**: open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/TheoTTP/ClaudeShape/claude/focused-turing-242l87/install.sh | bash
```

**Windows 10/11**: open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/TheoTTP/ClaudeShape/claude/focused-turing-242l87/install.ps1 | iex
```

The installer sets up Git, Node.js and Claude Code if they're missing, downloads ClaudeShape, and creates an app
(Mac: `~/Applications/ClaudeShape.app`; Windows: a Desktop and Start menu shortcut). Opening it shows a chat window.
First run: paste an Onshape API key in the window, and sign in to Claude Code once (`claude` in a terminal).
The app updates itself from GitHub each time it opens. These links only work while the repository is public.

## Desktop window (no terminal)

`node gui.js` (or `npm run gui`) opens a small chat window: type a part, get an Onshape link. It runs
Claude Code in the background (`claude -p`, restricted to the ClaudeShape tools), so it uses your Claude
login and needs no API key. The window pings the helper; closing the window stops it.

## In-Onshape panel (right side of a Part Studio)

A prompt box that lives inside Onshape. Whoever hosts it does the setup once; everyone else just clicks the icon.
The panel has a one-time settings box for **your own Anthropic API key** (kept in your browser only) and a
**Sign in to Onshape** button (popup, so it works inside Onshape's iframe).

Anthropic has no "Sign in with Claude" for third-party apps, so the panel can't use a Claude subscription.
That's what the MCP route above is for.

**1. Host it over HTTPS** (Onshape only frames https). Any Node/Docker host works (Render, Fly, Railway, Cloud Run):

```bash
docker build -t claudeshape . && docker run -p 8080:8080 --env-file .env claudeshape
```

Set `BASE_URL` (your public https URL), `SESSION_SECRET` (any long random string),
`ONSHAPE_CLIENT_ID` and `ONSHAPE_CLIENT_SECRET`. For a quick try from your laptop,
`npx cloudflared tunnel --url http://localhost:3000` gives a temporary https URL.

**2. Register the app** at <https://cad.onshape.com/user/developer> (My account > Developer):
- **OAuth applications > Create**: name `ClaudeShape`; redirect URL `$BASE_URL/oauth/callback`; permissions Read profile, Read documents, Write documents; primary format `https://…` (your BASE_URL). Copy the client id/secret into the server's env.
- On that app, **Extensions > Add**: name `ClaudeShape`; location **Element right panel**; context **Part Studio**; action URL
  `$BASE_URL/?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}`; icon `public/icon-96.png`.

**3. Install**: open any Part Studio; the ClaudeShape icon appears in the right-hand panel strip (if not, accept the app under Account > Applications). Click it, sign in, paste your Anthropic key once, and prompt.

## Files

| | |
|---|---|
| `mcp.js` | MCP server: the zero-setup way to use ClaudeShape |
| `scripts/setup.mjs` | One-time key save + Claude registration |
| `server.js` | Optional in-Onshape panel (Express, OAuth) |
| `lib/agent.js` | Claude tool-use loop and tool definitions |
| `lib/onshape.js` | REST client + feature-JSON builders |
| `scripts/make-icon.py` | Turns the source logo's white background into alpha |
| `scripts/smoke.mjs` | End-to-end test against fake Onshape/Claude servers |

## Caveats

Feature JSON was written from Onshape's documented schemas but only tested against mocks
(`npm test` checks sketch geometry closes up, parameter shapes and the agent loop), not a live
account. Expect to tweak parameter names if Onshape rejects one; errors are shown in the chat and
fed back to Claude. The least certain pieces are feature-pattern (`kind: "feature"`) parameters and
the x/y orientation of sketches placed on existing faces.
