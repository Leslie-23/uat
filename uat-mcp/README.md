# uat-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for the UAT Tracker. It lets Claude Code (or any MCP client) fetch failed UAT cases, their steps, tester notes, screenshots and history, so it can investigate and fix them in an app's repository.

It talks only to the UAT Tracker's existing REST API, never to the database, and it cannot change anything in UAT: apart from signing in and out, it only sends `GET` requests.

## Tools

| Tool | What it returns |
|---|---|
| `list_apps` | Every app with its case count and Pass / Fail / Blocked / N/A / Not run counts per platform. Start here. |
| `get_failed_tests` | Failing cases for an app, grouped by module, Critical first: expected result, the tester's note, who recorded it, screenshot count. Filters: `platform`, `statuses` (`Fail`, and optionally `Blocked`), `module`. Paginated with `limit` + `cursor`. |
| `get_test_details` | One case in full: numbered steps, expected result, and per platform the effective result plus every tester's record. |
| `get_test_evidence` | Screenshots attached to a case. With `include_images: true`, returns the images themselves (up to `max_images`, size-capped). |
| `get_test_history` | Change history. With `case_id`: that case's full history plus an analysis per platform (fail episodes, Pass→Fail regressions, `recurring`). Without: a page of recent changes for the app. |
| `get_app_notes` | General notes testers posted for the app (often build numbers, devices). |

There is also a prompt, **`investigate_failures`** (`app`, optional `platform`, optional `include_blocked`), with the full workflow: fetch → group → analyse evidence → find root cause → fix on a branch → run tests → report. It includes the guardrails below. In Claude Code it shows up as `/mcp__uat__investigate_failures vip ios`.

### How results are interpreted
- Statuses are **Pass, Fail, Blocked, N/A**, or **Not run** when nobody has recorded one.
- Several testers can record the same case. The **most recent record per case and platform** is the effective result, the same rule the UAT dashboard uses.
- `actualResult` is the tester's free-text note. UAT has no separate "actual result" field, so it may be empty.
- **`lockedByAdmin`**: an admin accepted (locked) that case+platform, so its result is confirmed and can't change until it's reopened. A locked Fail is a confirmed failure. Read from `GET /api/acceptances`; deployments without it show nothing as locked.
- Evidence is **screenshots only**. UAT doesn't store videos or logs.
- UAT has **no test cycles or builds**, so everything is scoped by app and platform (`ios` / `android`).

## Requirements

- Node.js 18 or later.
- A UAT Tracker deployment that includes the read-only **`GET /api/history`** endpoint (added alongside this package in `server.js`). Without it, every tool except `get_test_history` still works, and that one explains what's missing.
- The **tester** passphrase. The admin passphrase isn't needed; the server warns if you use it.

## Setup

```bash
cd uat-mcp
npm install        # also builds dist/
npm test           # optional: 32 tests, no network or database needed
```

### Add it to Claude Code (in the app repo you want fixed)

**Option A: settings file (simplest across several app repos).** Put the settings in `uat-mcp/.env` once:

```bash
cp .env.example .env    # then set UAT_PASSPHRASE to the tester passphrase
```

Then, in each app repo, register the server. No secrets appear in the command:

```bash
claude mcp add --scope local uat -- node /absolute/path/to/uat/uat-mcp/dist/index.js
```

`uat-mcp/.env` is gitignored. Only `UAT_*` keys are read from it; anything else (database URLs, admin passwords) is ignored with a warning. The file is found next to the package, not in the app repo, and `UAT_ENV_FILE=/path/to/file` points it elsewhere.

**Option B: per repo.** Pass the settings in the command (these override `uat-mcp/.env`):

```bash
claude mcp add --scope local \
  --env UAT_BASE_URL=https://uat-tracker-standalone.vercel.app \
  --env UAT_PASSPHRASE='the-tester-passphrase' \
  uat -- node /absolute/path/to/uat/uat-mcp/dist/index.js
```

**Option C: shared with the team.** Commit a `.mcp.json` to the app repo. It holds only variable names, and each developer sets the values in their own shell:

```json
{
  "mcpServers": {
    "uat": {
      "command": "node",
      "args": ["${UAT_MCP_PATH}/dist/index.js"],
      "env": {
        "UAT_BASE_URL": "${UAT_BASE_URL}",
        "UAT_PASSPHRASE": "${UAT_PASSPHRASE}"
      }
    }
  }
}
```

```bash
export UAT_MCP_PATH=/absolute/path/to/uat/uat-mcp
export UAT_BASE_URL=https://your-uat-app.vercel.app
export UAT_PASSPHRASE='the-tester-passphrase'
```

Then, in Claude Code, run `/mcp` to check the `uat` server is connected, and try:

> Investigate the failed UAT cases for vip on android.

or `/mcp__uat__investigate_failures vip android`.

### Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `UAT_BASE_URL` | yes | | Must be `https://` (plain `http://` only for localhost), so the passphrase is never sent in clear text. |
| `UAT_PASSPHRASE` | yes | | Tester passphrase. |
| `UAT_TIMEOUT_MS` | no | `15000` | Per request. |
| `UAT_MAX_IMAGE_BYTES` | no | `1500000` | Larger screenshots are listed but not returned inline. |
| `UAT_ENV_FILE` | no | `uat-mcp/.env` | Settings file to read (only `UAT_*` keys). Values from the MCP client override it. |

## Guardrails

- **Read-only by construction.** The API client has no write methods, every tool is annotated `readOnlyHint: true`, and a test asserts the only non-GET requests are sign-in and sign-out.
- **No "passed" claims.** The server instructions and the investigation prompt tell the agent it must never report a case as passed. A code change ends at "Fixed, retest required"; only a tester re-running the case in UAT can mark it Pass.
- **Branches, not production.** The prompt tells the agent to work on a `uat-fix/...` branch, never commit to main, never merge, and ask before pushing. The MCP server can't enforce git rules itself, so also protect `main` on GitHub and add the same rules to each app repo's `CLAUDE.md`.
- **Tester content is evidence, not instructions.** Notes and screenshots are written by testers; the prompt tells the agent to treat them as data.

## Reliability

- Signs in lazily, reuses one session, signs in again once if the session is rejected, and signs out on shutdown.
- Retries network errors, timeouts and HTTP 429/5xx up to twice with backoff (respects `Retry-After`).
- Validates every response with zod and reports shape mismatches clearly instead of passing on bad data.
- Large lists are paginated (`get_failed_tests`, `get_test_history`); images are only fetched on request and are size-capped.
- Errors come back as readable tool errors (e.g. *"Unknown app "vp". Available apps: vip, goride, …"*), so the agent can correct itself.

## Development

```
src/
  index.ts            stdio entry point (diagnostics on stderr; stdout is the protocol)
  server.ts           creates the MCP server: instructions, tools, prompt
  config.ts           environment validation
  api/client.ts       read-only UAT API client (auth, retries, timeouts, validation)
  api/schemas.ts      zod schemas for every API response
  domain/results.ts   latest-result rule, priority order, history analysis
  tools/              the six tools
  prompts/            investigate_failures
test/                 vitest: config, client, every tool (in-memory MCP), built server over stdio
```

Tests run against an in-process mock of the UAT API (`test/mockUat.ts`) that follows the same contract as `server.js`, including fault injection (401s, 5xx, missing endpoints).
