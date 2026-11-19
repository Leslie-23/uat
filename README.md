# uat

UAT Tracker: a web app where testers walk through test cases per app and platform, record Pass / Fail / Blocked / N/A, and attach notes and screenshots.

- `server.js`: Express + MongoDB API (also deployed to Vercel via `api/index.js`).
- `public/index.html`: the web UI.
- `seed.js` / `seed_data.json`: loads the test plan (`npm run seed`).
- [`uat-mcp/`](uat-mcp/README.md): a read-only MCP server that lets Claude Code and other MCP clients fetch failed UAT cases to investigate and fix them.
