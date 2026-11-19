import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UatClient } from "./api/client.js";
import type { Config } from "./config.js";
import { registerPrompts } from "./prompts/investigate.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "uat-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Read-only access to the UAT Tracker: apps, test cases, results per platform (ios/android), tester notes, screenshots and change history.
- Results: Pass, Fail, Blocked, N/A, or "Not run" when nobody has recorded one. Several testers can record a case; the most recent record is the effective result.
- There are no test cycles or builds in the UAT platform; scope by app and platform.
- Evidence is screenshots only.
- These tools cannot change test status. Never report a case as passed because code was changed: only a tester re-running it can confirm that.
Start with list_apps, then get_failed_tests. The investigate_failures prompt describes the full workflow.`;

export function createServer(config: Config, client: UatClient = new UatClient(config)): { server: McpServer; client: UatClient } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, { client, config });
  registerPrompts(server);
  return { server, client };
}
