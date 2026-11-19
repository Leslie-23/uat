#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, parseEnvFile } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

// stdout carries the MCP protocol; all diagnostics go to stderr.
const log = (msg: string) => console.error(`[${SERVER_NAME}] ${msg}`);

/**
 * Optional settings file. Defaults to uat-mcp/.env (next to the package, not the
 * directory Claude Code was started in). Override with UAT_ENV_FILE.
 */
function readSettingsFile(): Record<string, string> {
  const file = process.env.UAT_ENV_FILE || fileURLToPath(new URL("../.env", import.meta.url));
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (e) {
    if (process.env.UAT_ENV_FILE) log(`Couldn't read UAT_ENV_FILE ${file}: ${(e as Error).message}`);
    return {};
  }
  const { vars, ignored } = parseEnvFile(content);
  log(`Read ${Object.keys(vars).length} setting(s) from ${file}`);
  if (ignored.length) log(`Ignored non-UAT keys in ${file}: ${ignored.join(", ")}. Only UAT_* settings are read.`);
  return vars;
}

async function main(): Promise<void> {
  let config;
  try {
    // Values passed by the MCP client (e.g. `claude mcp add --env`) win over the file.
    config = loadConfig({ ...readSettingsFile(), ...process.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`Configuration problem:\n${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const { server, client } = createServer(config);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await client.close();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
  log(`v${SERVER_VERSION} ready (read-only) → ${config.baseUrl}`);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
