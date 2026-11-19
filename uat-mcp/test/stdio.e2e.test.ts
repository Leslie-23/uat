import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMock } from "./mockUat.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Exercises the built server exactly as Claude Code launches it: a child process speaking MCP over stdio.
describe.skipIf(!existsSync(entry))("built server over stdio", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  afterEach(() => mock?.close());

  it("starts, answers tool calls, and signs out on shutdown", async () => {
    mock = await startMock();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH ?? "", UAT_BASE_URL: mock.url, UAT_PASSPHRASE: "tester-pass" },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe("uat-mcp");
    expect(client.getInstructions()).toMatch(/Read-only/);
    const r = await client.callTool({ name: "get_failed_tests", arguments: { app: "vip" } });
    const data = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(data.totalMatching).toBe(2);

    await client.close();
    await new Promise((res) => setTimeout(res, 300));
    expect(mock.state.logouts).toBe(1);
  });

  it("exits with a readable message when misconfigured", async () => {
    const { spawnSync } = await import("node:child_process");
    // Point at a file that doesn't exist, so a real uat-mcp/.env on this machine can't make the test pass.
    const env = { PATH: process.env.PATH ?? "", UAT_ENV_FILE: "/nonexistent/uat-mcp.env" };
    const out = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 10_000 });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/UAT_BASE_URL is not set/);
    expect(out.stdout).toBe(""); // nothing may pollute the protocol stream
  });
});

describe.skipIf(!existsSync(entry))("settings file", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  afterEach(() => mock?.close());

  it("reads UAT_* settings from UAT_ENV_FILE, lets client env win, and ignores other keys", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    mock = await startMock();
    const file = join(mkdtempSync(join(tmpdir(), "uatmcp-")), ".env");
    writeFileSync(file, `UAT_BASE_URL=http://127.0.0.1:9\nUAT_PASSPHRASE=tester-pass\nMONGODB_URI=mongodb://should-not-be-read\n`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      // Base URL from the client env overrides the file's (unreachable) one; passphrase comes from the file.
      env: { PATH: process.env.PATH ?? "", UAT_ENV_FILE: file, UAT_BASE_URL: mock.url },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d) => (stderr += d));
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "list_apps", arguments: {} });
    expect(r.isError).toBeFalsy();
    await client.close();
    expect(stderr).toMatch(/Ignored non-UAT keys .*MONGODB_URI/);
  });
});
