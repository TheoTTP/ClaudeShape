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

## Optional: in-Onshape panel

If you want a prompt box inside Onshape itself, `server.js` serves one. That path *does* need an
`ANTHROPIC_API_KEY`, an HTTPS host and an Onshape OAuth app (see `.env.example`):

```bash
cp .env.example .env && node --env-file=.env server.js
```

Register it under <https://dev-portal.onshape.com> as an Element right panel extension with action URL
`$BASE_URL/?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}`
and OAuth redirect `$BASE_URL/oauth/callback`.

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
