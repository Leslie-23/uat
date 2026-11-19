import { afterEach, describe, expect, it } from "vitest";
import { UatApiError, UatClient } from "../src/api/client.js";
import { startMock } from "./mockUat.js";

let mock: Awaited<ReturnType<typeof startMock>>;
afterEach(() => mock?.close());

const clientFor = (url: string, passphrase = "tester-pass") =>
  new UatClient({ baseUrl: url, passphrase, timeoutMs: 5000, maxImageBytes: 100_000 }, undefined, () => {});

describe("UatClient", () => {
  it("signs in once and reuses the session", async () => {
    mock = await startMock();
    const c = clientFor(mock.url);
    await Promise.all([c.listResults({ app: "vip" }), c.listNotes("vip"), c.listResults()]);
    expect(mock.state.logins).toBe(1);
    expect(c.role).toBe("tester");
  });

  it("explains a wrong passphrase", async () => {
    mock = await startMock();
    await expect(clientFor(mock.url, "nope").listResults()).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("signs in again when the session is dropped", async () => {
    mock = await startMock();
    const c = clientFor(mock.url);
    await c.listResults();
    mock.state.dropSessions();
    await expect(c.listResults()).resolves.toHaveLength(6);
    expect(mock.state.logins).toBe(2);
  });

  it("retries transient server errors, then gives up with a clear error", async () => {
    mock = await startMock();
    const c = clientFor(mock.url);
    mock.state.failNext["/api/results"] = { status: 503, count: 2 };
    await expect(c.listResults()).resolves.toHaveLength(6);
    mock.state.failNext["/api/results"] = { status: 500, count: 5 };
    await expect(c.listResults()).rejects.toMatchObject({ code: "http_error", status: 500 });
  });

  it("rejects responses in an unexpected shape", async () => {
    mock = await startMock();
    mock.state.results.push({ app: "vip" }); // no caseId/platform
    await expect(clientFor(mock.url).listResults()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("explains when the history endpoint isn't deployed", async () => {
    mock = await startMock({ historyEnabled: false });
    await expect(clientFor(mock.url).listHistory({ app: "vip" })).rejects.toMatchObject({ code: "history_unavailable" });
  });

  it("refuses malformed attachment ids without calling the server", async () => {
    mock = await startMock();
    const c = clientFor(mock.url);
    await expect(c.getAttachmentImage("../admin")).rejects.toBeInstanceOf(UatApiError);
    expect(mock.state.requests.some((r) => r.includes("admin"))).toBe(false);
  });

  it("only ever issues GET requests, besides signing in and out", async () => {
    mock = await startMock();
    const c = clientFor(mock.url);
    await c.listTestCases();
    await c.listResults();
    await c.listAttachments({ app: "vip" });
    await c.getAttachmentImage("aaaaaaaaaaaaaaaaaaaaaaa1");
    await c.listHistory({ app: "vip" });
    await c.listNotes("vip");
    await c.listAcceptances({ app: "vip" });
    await c.close();
    const writes = mock.state.requests.filter((r) => !r.startsWith("GET "));
    expect(writes).toEqual(["POST /api/auth", "POST /api/logout"]);
    expect(mock.state.logouts).toBe(1);
  });

  it("reports an unreachable server", async () => {
    const c = clientFor("http://127.0.0.1:9");
    await expect(c.listResults()).rejects.toMatchObject({ code: "network" });
  });
});
