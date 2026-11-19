import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UatApiError } from "../api/client.js";
import type { Attachment, HistoryEntry } from "../api/schemas.js";
import {
  PLATFORMS, RECORDED_STATUSES, analyseHistory, findCase, latestPerCase, parseSteps, priorityRank, resultKey, statusOf,
  type Platform, type Status,
} from "../domain/results.js";
import { READ_ONLY, decodeCursor, encodeCursor, ok, resolveApp, safe, type ToolContext } from "./util.js";

const platformArg = z.enum(PLATFORMS).optional().describe('Limit to one platform: "ios" or "android". Omit for both.');
const appArg = z.string().min(1).describe('App id from list_apps, e.g. "vip". Matching ignores case and spaces.');
const caseArg = z.string().min(1).describe('Test case id, e.g. "VIP-04".');

const ACTUAL_RESULT_NOTE =
  "actualResult is the tester's free-text note. It may be empty, and when several testers recorded a case it belongs to whoever recorded last.";

function countByStatus(): Record<Status, number> {
  return { Pass: 0, Fail: 0, Blocked: 0, "N/A": 0, "Not run": 0 };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  // ------------------------------------------------------------------ list_apps
  server.registerTool(
    "list_apps",
    {
      title: "List UAT apps",
      description:
        "Lists the apps on the UAT platform with case counts and per-platform result counts (Pass/Fail/Blocked/N/A/Not run). Start here to pick an app.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const [cases, results] = await Promise.all([client.listTestCases(), client.listResults()]);
      const latest = latestPerCase(results);
      const apps = new Map<string, { caseCount: number; modules: Set<string>; byPlatform: Record<string, Record<Status, number>> }>();
      for (const c of cases) {
        let a = apps.get(c.app);
        if (!a) {
          a = { caseCount: 0, modules: new Set(), byPlatform: Object.fromEntries(PLATFORMS.map((p) => [p, countByStatus()])) };
          apps.set(c.app, a);
        }
        a.caseCount++;
        if (c.module) a.modules.add(c.module);
        for (const p of PLATFORMS) a.byPlatform[p]![statusOf(latest.get(resultKey(c.id, p)))]++;
      }
      return ok({
        apps: [...apps].map(([app, a]) => ({ app, caseCount: a.caseCount, moduleCount: a.modules.size, results: a.byPlatform })),
        platforms: PLATFORMS,
      });
    }),
  );

  // ------------------------------------------------------------------ get_failed_tests
  server.registerTool(
    "get_failed_tests",
    {
      title: "Get failed UAT tests",
      description:
        "Returns an app's failing test cases, grouped by module and ordered by priority (Critical first). " +
        "Each case's effective result is the most recent one recorded on that platform. " +
        "Includes the expected result, the tester's note (actualResult) and how many screenshots exist. Paginated.",
      inputSchema: {
        app: appArg,
        platform: platformArg,
        statuses: z.array(z.enum(["Fail", "Blocked"])).min(1).default(["Fail"])
          .describe('Which statuses count as failing. Default ["Fail"]; add "Blocked" to include cases testers couldn\'t run.'),
        module: z.string().optional().describe("Only cases in this module (case-insensitive)."),
        limit: z.number().int().min(1).max(200).default(50).describe("Page size (max 200)."),
        cursor: z.string().optional().describe("nextCursor from a previous call, to fetch the next page."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ app, platform, statuses, module, limit, cursor }) => {
      const appId = await resolveApp(ctx, app);
      const offset = decodeCursor(cursor);
      const [cases, results, attachments] = await Promise.all([
        client.listTestCases(appId),
        client.listResults({ app: appId, platform }),
        client.listAttachments({ app: appId, platform }),
      ]);
      const latest = latestPerCase(results);
      const shots = new Map<string, number>();
      for (const a of attachments) {
        const k = resultKey(a.caseId, a.platform ?? "");
        shots.set(k, (shots.get(k) ?? 0) + 1);
      }
      const platforms: Platform[] = platform ? [platform] : [...PLATFORMS];
      const wanted = new Set<string>(statuses);
      const mod = module?.trim().toLowerCase();

      const matches = [];
      for (const c of cases) {
        if (mod && c.module.toLowerCase() !== mod) continue;
        for (const p of platforms) {
          const rec = latest.get(resultKey(c.id, p));
          const status = statusOf(rec);
          if (!wanted.has(status)) continue;
          matches.push({
            caseId: c.id, platform: p, status, priority: c.priority, module: c.module || "General",
            scenario: c.scenario, expected: c.expected,
            actualResult: rec?.comments?.trim() || null,
            recordedBy: rec?.tester ?? null, recordedAt: rec?.updatedAt ?? null,
            screenshots: shots.get(resultKey(c.id, p)) ?? 0,
            order: c.order,
          });
        }
      }
      matches.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.order - b.order || a.platform.localeCompare(b.platform));

      const byModule: Record<string, number> = {};
      const byPlatform: Record<string, number> = {};
      for (const m of matches) {
        byModule[m.module] = (byModule[m.module] ?? 0) + 1;
        byPlatform[m.platform] = (byPlatform[m.platform] ?? 0) + 1;
      }

      const page = matches.slice(offset, offset + limit);
      const groups: { module: string; cases: Omit<(typeof page)[number], "module" | "order">[] }[] = [];
      for (const { module: m, order: _order, ...rest } of page) {
        let g = groups.find((x) => x.module === m);
        if (!g) groups.push((g = { module: m, cases: [] }));
        g.cases.push(rest);
      }
      const next = offset + limit < matches.length ? encodeCursor(offset + limit) : null;
      return ok({
        app: appId,
        filters: { platforms, statuses, module: module ?? null },
        totalMatching: matches.length,
        returned: page.length,
        summary: { byPlatform, byModule },
        groups,
        nextCursor: next,
        notes: [ACTUAL_RESULT_NOTE, "Use get_test_details for steps and every tester's record, and get_test_evidence for screenshots."],
      });
    }),
  );

  // ------------------------------------------------------------------ get_test_details
  server.registerTool(
    "get_test_details",
    {
      title: "Get UAT test details",
      description:
        "Full detail for one test case: module, priority, numbered steps, expected result, and per platform the effective result " +
        "plus every tester's record (status, note, time). Also counts screenshots per platform.",
      inputSchema: { app: appArg, case_id: caseArg },
      annotations: READ_ONLY,
    },
    safe(async ({ app, case_id }) => {
      const appId = await resolveApp(ctx, app);
      const cases = await client.listTestCases(appId);
      const tc = findCase(cases, case_id);
      if (!tc) throw new UatApiError(`No test case "${case_id}" in ${appId}. It has ${cases.length} cases, e.g. ${cases.slice(0, 3).map((c) => c.id).join(", ")}.`, "unknown_case");
      const [results, attachments] = await Promise.all([
        client.listResults({ app: appId }),
        client.listAttachments({ app: appId, caseId: tc.id }),
      ]);
      const mine = results.filter((r) => r.caseId === tc.id);
      const latest = latestPerCase(mine);
      const platforms = Object.fromEntries(
        PLATFORMS.map((p) => {
          const rec = latest.get(resultKey(tc.id, p));
          const records = mine
            .filter((r) => r.platform === p)
            .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0))
            .map((r) => ({ tester: r.tester, status: statusOf(r), note: r.comments?.trim() || null, updatedAt: r.updatedAt }));
          return [p, {
            status: statusOf(rec),
            actualResult: rec?.comments?.trim() || null,
            recordedBy: rec?.tester ?? null,
            recordedAt: rec?.updatedAt ?? null,
            screenshots: attachments.filter((a) => a.platform === p).length,
            allTesterRecords: records,
          }];
        }),
      );
      return ok({
        case: {
          id: tc.id, app: appId, module: tc.module, scenario: tc.scenario, priority: tc.priority,
          steps: parseSteps(tc.steps), expected: tc.expected,
        },
        platforms,
        notes: [ACTUAL_RESULT_NOTE],
      });
    }),
  );

  // ------------------------------------------------------------------ get_test_evidence
  server.registerTool(
    "get_test_evidence",
    {
      title: "Get UAT test evidence",
      description:
        "Lists the screenshots attached to a test case (newest first) and, with include_images=true, returns them as images you can look at. " +
        "The UAT platform only stores screenshots: there are no videos or logs.",
      inputSchema: {
        app: appArg,
        case_id: caseArg,
        platform: platformArg,
        include_images: z.boolean().default(false).describe("Return the image data, not just the list."),
        max_images: z.number().int().min(1).max(10).default(3).describe("Most images to return when include_images is true."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ app, case_id, platform, include_images, max_images }) => {
      const appId = await resolveApp(ctx, app);
      const tc = findCase(await client.listTestCases(appId), case_id);
      if (!tc) throw new UatApiError(`No test case "${case_id}" in ${appId}.`, "unknown_case");
      const list = await client.listAttachments({ app: appId, caseId: tc.id, platform });
      const describe = (a: Attachment) => ({
        id: a._id, platform: a.platform, filename: a.filename, mimeType: a.mimeType, uploadedBy: a.tester, uploadedAt: a.createdAt,
      });

      const images: CallToolResult["content"] = [];
      const skipped: { id: string; reason: string }[] = [];
      if (include_images) {
        for (const a of list.slice(0, max_images)) {
          try {
            const img = await client.getAttachmentImage(a._id);
            const bytes = Math.floor(img.image.length * 0.75);
            if (bytes > config.maxImageBytes) {
              skipped.push({ id: a._id, reason: `too large (${(bytes / 1e6).toFixed(1)} MB > UAT_MAX_IMAGE_BYTES)` });
              continue;
            }
            images.push({ type: "image", data: img.image, mimeType: img.mimeType || a.mimeType || "image/png" });
          } catch (e) {
            skipped.push({ id: a._id, reason: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      return ok(
        {
          app: appId, caseId: tc.id, platform: platform ?? null,
          count: list.length,
          screenshots: list.map(describe),
          imagesReturned: images.length,
          skipped,
          notes: list.length
            ? include_images ? [] : ["Call again with include_images=true to see the screenshots."]
            : ["No screenshots attached to this case."],
        },
        images,
      );
    }),
  );

  // ------------------------------------------------------------------ get_test_history
  server.registerTool(
    "get_test_history",
    {
      title: "Get UAT test history",
      description:
        "Change history, newest first. With case_id, fetches that case's full history and analyses it per platform " +
        "(fail episodes, Pass→Fail regressions, recurring flag). Without case_id, returns a page of recent changes for the app.",
      inputSchema: {
        app: appArg,
        case_id: caseArg.optional(),
        platform: platformArg,
        limit: z.number().int().min(1).max(500).default(100).describe("Entries to return (max 500)."),
        cursor: z.string().optional().describe("nextCursor from a previous call (only without case_id)."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ app, case_id, platform, limit, cursor }) => {
      const appId = await resolveApp(ctx, app);
      const shape = (e: HistoryEntry) => ({
        caseId: e.caseId, platform: e.platform, tester: e.tester,
        status: e.result ? statusOf(e) : null, change: e.result ? "status" : "note", note: e.comments?.trim() || null, at: e.changedAt,
      });

      if (!case_id) {
        const page = await client.listHistory({ app: appId, platform, limit, cursor });
        return ok({ app: appId, platform: platform ?? null, entries: page.items.map(shape), nextCursor: page.nextCursor });
      }

      const tc = findCase(await client.listTestCases(appId), case_id);
      if (!tc) throw new UatApiError(`No test case "${case_id}" in ${appId}.`, "unknown_case");
      // A single case has few entries; read all of it (bounded) so the analysis is complete.
      const all: HistoryEntry[] = [];
      let next: string | null | undefined;
      let pages = 0;
      do {
        const page = await client.listHistory({ app: appId, caseId: tc.id, platform, limit: 500, cursor: next ?? undefined });
        all.push(...page.items);
        next = page.nextCursor;
      } while (next && ++pages < 10);
      return ok({
        app: appId,
        caseId: tc.id,
        platform: platform ?? null,
        analysis: analyseHistory(all),
        totalEntries: all.length,
        truncated: Boolean(next),
        entries: all.slice(0, limit).map(shape),
      });
    }),
  );

  // ------------------------------------------------------------------ get_app_notes
  server.registerTool(
    "get_app_notes",
    {
      title: "Get UAT app notes",
      description:
        "General notes testers posted for an app that aren't tied to one case, newest first. Often mention the build number, devices or crashes spanning several cases.",
      inputSchema: { app: appArg, limit: z.number().int().min(1).max(200).default(50) },
      annotations: READ_ONLY,
    },
    safe(async ({ app, limit }) => {
      const appId = await resolveApp(ctx, app);
      const notes = await client.listNotes(appId);
      return ok({
        app: appId,
        count: notes.length,
        notes: notes.slice(0, limit).map((n) => ({ by: n.tester, at: n.createdAt, text: n.text })),
      });
    }),
  );
}

export const TOOL_NAMES = ["list_apps", "get_failed_tests", "get_test_details", "get_test_evidence", "get_test_history", "get_app_notes"] as const;
export { RECORDED_STATUSES };
