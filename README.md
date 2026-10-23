# Penpot for COGNIX[WS]

A [COGNIX[WS]](https://cognix.ws) extension that lets your agents work in
your [Penpot](https://penpot.app) files through Penpot's own MCP server.

- **`import_image`.** An agent names a picture on this computer (PNG, JPEG,
  GIF or WEBP, up to 10 MB) and it lands in the open Penpot file as a
  rectangle filled with it. Penpot's hosted MCP server has no import of its
  own and refuses requests above about 100 KB, so the extension sends the
  picture in 72 KB pieces through Penpot's `execute_code`, six at a time,
  then assembles it in the Penpot tab. Measured on 2026-10-23: 495 KB
  (3200×2000) in 2.6 s, 5.5 MB in 10 s.
- **A skill** that tells agents how to connect the Penpot tab, build boards
  from a COGNIX[WS] design, import pictures and export boards.
- **A guide** in Help & guides that walks you through connecting an agent.

The extension never holds your Penpot key. COGNIX[WS] adds `import_image` to
your Penpot MCP server's tools (extension door I), and when an agent calls
it, the extension reaches Penpot back through COGNIX[WS], which fills in the
server's address and key.

## Set up

1. In Penpot, open Your account ▸ Integrations ▸ MCP Server and create a
   key. When an agent asks for `PENPOT_MCP_KEY`, paste it in the field
   under the agent's terminal.
2. In COGNIX[WS], open Integrations ▸ MCP servers and add a server named
   `penpot`, type URL, with the address
   `https://design.penpot.app/mcp/stream?userToken=${PENPOT_MCP_KEY}`.
3. Tick `penpot` in the agent's launch settings and restart the agent.
4. Install this extension (Extensions ▸ Install, with this repository's
   address or folder) and turn it on for this computer.
5. Open the file in Penpot and click **MCP** in the toolbar until it reads
   "MCP connected". Keep that tab open: a hidden tab falls asleep, and the
   tools wait for it.

## Develop

Node 24, no dependencies. `npm test` runs the tests against a stand-in for
the Penpot tab that runs the real assembly code.
