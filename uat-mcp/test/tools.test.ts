import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { UatClient } from "../src/api/client.js";
import { createServer } from "../src/server.js";
import { startMock } from "./mockUat.js";

let mock: Awaited<ReturnType<typeof startMock>>;
afterEach(() => mock?.close());

async function connect(overrides: Parameters<typeof startMock>[0] = {}) {
  mock = await startMock(overrides);
  const config = { baseUrl: mock.url, passphrase: "tester-pass", timeoutMs: 5000, maxImageBytes: 100_000 };
  const { server } = createServer(config, new UatClient(config, undefined, () => {}));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
    return { raw: r, isError: Boolean(r.isError), text, data: r.isError ? null : (JSON.parse(text) as any) };
  };
  return { client, call };
}

describe("tool surface", () => {
  it("exposes exactly the six read-only tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_app_notes", "get_failed_tests", "get_test_details", "get_test_evidence", "get_test_history", "list_apps"],
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("ships the investigation prompt with its guardrails", async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: "investigate_failures", arguments: { app: "vip", platform: "ios" } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/platform="ios"/);
    expect(text).toMatch(/never describe a case as "passed"/);
    expect(text).toMatch(/Fixed, retest required/);
  });
});

describe("list_apps", () => {
  it("summarises results per app and platform using the latest record", async () => {
    const { call } = await connect();
    const { data } = await call("list_apps");
    const vip = data.apps.find((a: any) => a.app === "vip");
    expect(vip.caseCount).toBe(3);
    // VIP-02 on iOS: Kofi Pass, then Ama Fail later → counts as Fail.
    expect(vip.results.ios).toEqual({ Pass: 1, Fail: 1, Blocked: 1, "N/A": 0, "Not run": 0 });
    expect(vip.results.android).toEqual({ Pass: 0, Fail: 1, Blocked: 0, "N/A": 0, "Not run": 2 });
    // VIP-02 iOS was accepted then reopened (accepted:false), so only VIP-01 Android is locked.
    expect(vip.lockedByAdmin).toEqual({ ios: 0, android: 1 });
  });
});

describe("get_failed_tests", () => {
  it("returns failures grouped by module, Critical first", async () => {
    const { call } = await connect();
    const { data } = await call("get_failed_tests", { app: "vip" });
    expect(data.totalMatching).toBe(2);
    expect(data.groups.map((g: any) => g.module)).toEqual(["Bus booking", "Login"]);
    const seat = data.groups[0].cases[0];
    expect(seat).toMatchObject({ caseId: "VIP-02", platform: "ios", status: "Fail", priority: "Critical", actualResult: "Seat released after 10s", recordedBy: "Ama", screenshots: 2, lockedByAdmin: false });
    expect(data.groups[1].cases[0]).toMatchObject({ caseId: "VIP-01", platform: "android", lockedByAdmin: true });
  });

  it("can include Blocked, filter by platform and module, and matches app names loosely", async () => {
    const { call } = await connect();
    expect((await call("get_failed_tests", { app: "V I P", statuses: ["Fail", "Blocked"] })).data.totalMatching).toBe(3);
    expect((await call("get_failed_tests", { app: "vip", platform: "android" })).data.totalMatching).toBe(1);
    expect((await call("get_failed_tests", { app: "vip", module: "login" })).data.totalMatching).toBe(1);
  });

  it("paginates with an opaque cursor", async () => {
    const { call } = await connect();
    const first = (await call("get_failed_tests", { app: "vip", limit: 1 })).data;
    expect(first.returned).toBe(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await call("get_failed_tests", { app: "vip", limit: 1, cursor: first.nextCursor })).data;
    expect(second.groups[0].cases[0].caseId).toBe("VIP-01");
    expect(second.nextCursor).toBeNull();
    expect((await call("get_failed_tests", { app: "vip", cursor: "garbage" })).isError).toBe(true);
  });

  it("names the available apps when the app is unknown", async () => {
    const { call } = await connect();
    const r = await call("get_failed_tests", { app: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Available apps: vip, goride/);
  });
});

describe("get_test_details", () => {
  it("returns steps and every tester's record per platform", async () => {
    const { call } = await connect();
    const { data } = await call("get_test_details", { app: "vip", case_id: "vip-02" });
    expect(data.case.steps).toEqual(["Pick a route.", "Select a seat."]);
    expect(data.platforms.ios.status).toBe("Fail");
    expect(data.platforms.ios.allTesterRecords.map((r: any) => r.tester)).toEqual(["Ama", "Kofi"]);
    expect(data.platforms.android.status).toBe("Not run");
    expect(data.platforms.ios.screenshots).toBe(2);
    expect(data.platforms.ios.lockedByAdmin).toBe(false);
  });

  it("treats deployments without the acceptances endpoint as nothing locked", async () => {
    const { call } = await connect({ acceptancesEnabled: false });
    const { data } = await call("get_test_details", { app: "vip", case_id: "VIP-01" });
    expect(data.platforms.android).toMatchObject({ status: "Fail", lockedByAdmin: false });
  });

  it("errors clearly for an unknown case", async () => {
    const { call } = await connect();
    const r = await call("get_test_details", { app: "vip", case_id: "VIP-99" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No test case "VIP-99"/);
  });
});

describe("get_test_evidence", () => {
  it("lists screenshots and only returns images when asked, skipping oversized ones", async () => {
    const { call } = await connect();
    const list = await call("get_test_evidence", { app: "vip", case_id: "VIP-02" });
    expect(list.data.count).toBe(2);
    expect(list.data.imagesReturned).toBe(0);

    const withImages = await call("get_test_evidence", { app: "vip", case_id: "VIP-02", include_images: true });
    const content = withImages.raw.content as { type: string; mimeType?: string }[];
    expect(content.filter((c) => c.type === "image")).toEqual([expect.objectContaining({ type: "image", mimeType: "image/png" })]);
    expect(withImages.data.skipped[0].reason).toMatch(/too large/);
  });
});

describe("get_test_history", () => {
  it("detects a recurring failure and a regression for one case", async () => {
    const { call } = await connect();
    const { data } = await call("get_test_history", { app: "vip", case_id: "VIP-02" });
    const ios = data.analysis.find((a: any) => a.platform === "ios");
    expect(ios).toMatchObject({ fails: 2, passes: 1, regressions: 1, failEpisodes: 2, recurring: true, currentStatus: "Fail" });
    expect(data.entries[0]).toMatchObject({ change: "note", status: null }); // newest is a note-only edit
    expect(data.totalEntries).toBe(4);
  });

  it("pages through app history", async () => {
    const { call } = await connect();
    const first = (await call("get_test_history", { app: "vip", limit: 2 })).data;
    expect(first.entries).toHaveLength(2);
    const rest = (await call("get_test_history", { app: "vip", limit: 10, cursor: first.nextCursor })).data;
    expect(rest.entries).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();
  });

  it("explains when the server doesn't have the history endpoint yet", async () => {
    const { call } = await connect({ historyEnabled: false });
    const r = await call("get_test_history", { app: "vip", case_id: "VIP-02" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/GET \/api\/history/);
  });
});

describe("get_app_notes", () => {
  it("returns app-level notes", async () => {
    const { call } = await connect();
    const { data } = await call("get_app_notes", { app: "vip" });
    expect(data.notes[0].text).toMatch(/build 2\.4\.1/);
  });
});
