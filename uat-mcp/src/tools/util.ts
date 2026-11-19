import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UatApiError, type UatClient } from "../api/client.js";
import type { Config } from "../config.js";
import { normalizeId } from "../domain/results.js";

export interface ToolContext {
  client: UatClient;
  config: Config;
}

/** Every tool here only reads from the UAT API. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Successful result: JSON text for any client, plus structuredContent for clients that use it. */
export function ok(data: Record<string, unknown>, extra: CallToolResult["content"] = []): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }, ...extra],
    structuredContent: data,
  };
}

/** Error result the model can read and act on, instead of a protocol-level failure. */
export function fail(e: unknown): CallToolResult {
  const message =
    e instanceof UatApiError ? e.message : e instanceof Error ? `Unexpected error: ${e.message}` : `Unexpected error: ${String(e)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wraps a tool handler so every error becomes a readable tool error. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

/** Resolves a user-supplied app name to a known app id, or explains which ones exist. */
export async function resolveApp(ctx: ToolContext, app: string): Promise<string> {
  const cases = await ctx.client.listTestCases();
  const ids = [...new Set(cases.map((c) => c.app))];
  const match = ids.find((id) => normalizeId(id) === normalizeId(app));
  if (match) return match;
  throw new UatApiError(
    ids.length
      ? `Unknown app "${app}". Available apps: ${ids.join(", ")}. Call list_apps for details.`
      : "The UAT server has no test cases loaded yet.",
    "unknown_app",
  );
}

/** Opaque offset cursor for paginating lists the server returns in full. */
export const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString("base64url");
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!m) throw new UatApiError("Invalid cursor. Pass nextCursor exactly as returned by the previous call.", "invalid_cursor");
  return Number(m[1]);
}
