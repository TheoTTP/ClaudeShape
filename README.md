<img src="public/icon-96.png" align="right" alt="ClaudeShape">

# ClaudeShape

An Onshape app that lets Claude do the CAD. Open it in a Part Studio, type
"a 60×40×10 mm plate with four 5 mm corner holes", and Claude builds it as real,
editable Onshape features (sketches with lines/arcs/slots/paths, extrudes, cuts, revolves, fillets, chamfers, offset planes, linear and circular patterns, sketches on existing faces)
through the Onshape REST API.

```
Onshape tab (iframe)  ──prompt──▶  server.js  ──▶  Claude (tool use)
                                       │                 │
                                       └──── Onshape REST API ◀── create_sketch / extrude / fillet …
```

Claude reads the current feature list, calls tools, checks each feature's status
(and the part's bounding box), and fixes errors itself before summarising.

## Run it

```bash
npm install
cp .env.example .env   # fill in keys
node --env-file=.env server.js
```

Quick local try (no OAuth): set `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY` and open
`http://localhost:3000/?documentId=…&workspaceId=…&elementId=…` using ids from a Part Studio URL
(`/documents/<did>/w/<wid>/e/<eid>`).

## Register it in Onshape

1. <https://dev-portal.onshape.com> → **OAuth applications → Create**. Redirect URL: `$BASE_URL/oauth/callback`; permissions: read profile, read & write documents. Put the id/secret in `.env`.
2. Under **Extensions** add a *Element right panel* (or *Element tab*) extension:
   - Location: Element right panel / Part Studio
   - Action URL: `$BASE_URL/?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}`
   - Icon: `public/icon-512.png` (transparent)
3. Host over HTTPS (Onshape won't frame http). Cookies are `SameSite=None; Secure` for the iframe.

## Files

| | |
|---|---|
| `server.js` | Express, Onshape OAuth, streaming `/api/prompt` |
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
