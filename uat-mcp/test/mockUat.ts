import http from "node:http";
import type { AddressInfo } from "node:net";

/** In-process stand-in for the UAT Tracker API (server.js), for tests only. */

const iso = (min: number) => new Date(Date.UTC(2026, 10, 1, 9, min)).toISOString();
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function fixture() {
  return {
    passphrase: "tester-pass",
    cases: [
      { _id: "VIP-01", id: "VIP-01", app: "vip", order: 0, module: "Login", scenario: "Log in by phone OTP", steps: "1. Open the app.\n2. Enter your phone number.\n3. Enter the OTP.", expected: "You land on Home.", priority: "High" },
      { _id: "VIP-02", id: "VIP-02", app: "vip", order: 1, module: "Bus booking", scenario: "Book a scheduled trip", steps: "1. Pick a route.\n2. Select a seat.", expected: "Seat is held.", priority: "Critical" },
      { _id: "VIP-03", id: "VIP-03", app: "vip", order: 2, module: "Bus booking", scenario: "Book an unscheduled trip", steps: "1. Pick a date.", expected: "You reach payment.", priority: "Low" },
      { _id: "GOR-01", id: "GOR-01", app: "goride", order: 0, module: "Login", scenario: "Log in", steps: "1. Open.", expected: "Home.", priority: "High" },
    ],
    results: [
      { _id: "VIP-01__ios__ama", caseId: "VIP-01", app: "vip", platform: "ios", tester: "Ama", result: "Pass", updatedAt: iso(1) },
      { _id: "VIP-01__android__kofi", caseId: "VIP-01", app: "vip", platform: "android", tester: "Kofi", result: "Fail", comments: "App crashes after entering OTP", updatedAt: iso(2) },
      { _id: "VIP-02__ios__kofi", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Kofi", result: "Pass", updatedAt: iso(1) },
      { _id: "VIP-02__ios__ama", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", result: "Fail", comments: "Seat released after 10s", updatedAt: iso(3) },
      { _id: "VIP-03__ios__ama", caseId: "VIP-03", app: "vip", platform: "ios", tester: "Ama", result: "Blocked", comments: "No unscheduled routes in test data", updatedAt: iso(4) },
      { _id: "GOR-01__android__ama", caseId: "GOR-01", app: "goride", platform: "android", tester: "Ama", result: "Fail", updatedAt: iso(5) },
    ] as Record<string, unknown>[],
    history: [
      { _id: "000000000000000000000001", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", result: "Fail", comments: "Seat released", changedAt: iso(0) },
      { _id: "000000000000000000000002", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Kofi", result: "Pass", comments: null, changedAt: iso(1) },
      { _id: "000000000000000000000003", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", result: "Fail", comments: "Seat released after 10s", changedAt: iso(3) },
      { _id: "000000000000000000000004", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", result: null, comments: "Seat released after 10s on 2.4.1", changedAt: iso(6) },
      { _id: "000000000000000000000005", caseId: "VIP-01", app: "vip", platform: "android", tester: "Kofi", result: "Fail", comments: "App crashes", changedAt: iso(2) },
    ] as Record<string, unknown>[],
    attachments: [
      { _id: "aaaaaaaaaaaaaaaaaaaaaaa1", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", filename: "seat.png", mimeType: "image/png", createdAt: iso(3), image: PNG_1PX },
      { _id: "aaaaaaaaaaaaaaaaaaaaaaa2", caseId: "VIP-02", app: "vip", platform: "ios", tester: "Ama", filename: "huge.png", mimeType: "image/png", createdAt: iso(2), image: "A".repeat(400_000) },
    ],
    acceptances: [
      { _id: "vip__VIP-01__android", app: "vip", caseId: "VIP-01", platform: "android", accepted: true, acceptedAt: iso(7) },
      { _id: "vip__VIP-02__ios", app: "vip", caseId: "VIP-02", platform: "ios", accepted: false, acceptedAt: iso(4) },
    ] as Record<string, unknown>[],
    notes: [{ _id: "n1", app: "vip", tester: "Ama", text: "Testing build 2.4.1 (412) on iPhone 13", createdAt: iso(0) }],
  };
}

export type MockState = ReturnType<typeof fixture> & {
  historyEnabled: boolean;
  acceptancesEnabled: boolean;
  /** Fail the next N requests to a path with this status. */
  failNext: Record<string, { status: number; count: number }>;
  /** Invalidate every session (simulates sessions being cleared server-side). */
  dropSessions: () => void;
  logins: number;
  logouts: number;
  requests: string[];
};

export async function startMock(overrides: Partial<MockState> = {}) {
  const sessions = new Set<string>();
  const state: MockState = {
    ...fixture(), historyEnabled: true, acceptancesEnabled: true, failNext: {}, logins: 0, logouts: 0, requests: [],
    dropSessions: () => sessions.clear(),
    ...overrides,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    state.requests.push(`${req.method} ${path}${url.search}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const injected = state.failNext[path];
    if (injected && injected.count > 0) { injected.count--; return send(injected.status, { error: "injected failure" }); }

    if (req.method === "POST" && path === "/api/auth") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { password } = JSON.parse(raw || "{}");
      if (password !== state.passphrase) return send(401, { error: "wrong_password" });
      const token = `tok${++state.logins}`;
      sessions.add(token);
      return send(200, { token, role: "tester" });
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sessions.has(token)) return send(401, { error: "not_authenticated" });

    const by = <T extends Record<string, unknown>>(rows: T[], keys: string[]) =>
      rows.filter((r) => keys.every((k) => q(k) === undefined || r[k] === q(k)));

    if (req.method === "POST" && path === "/api/logout") { sessions.delete(token); state.logouts++; return send(200, { ok: true }); }
    if (req.method !== "GET") return send(404, { error: "not found" });
    if (path === "/api/testcases") return send(200, by(state.cases, ["app"]));
    if (path === "/api/results") return send(200, by(state.results, ["app", "platform"]));
    if (path === "/api/attachments") return send(200, by(state.attachments, ["app", "caseId", "platform"]).map(({ image: _i, ...m }) => m));
    const img = /^\/api\/attachments\/([^/]+)\/image$/.exec(path);
    if (img) {
      const a = state.attachments.find((x) => x._id === img[1]);
      return a ? send(200, { image: a.image, mimeType: a.mimeType }) : send(404);
    }
    if (path === "/api/comments") return send(200, by(state.notes, ["app"]));
    if (path === "/api/acceptances" && state.acceptancesEnabled) return send(200, by(state.acceptances, ["app", "platform"]));
    if (path === "/api/history" && state.historyEnabled) {
      // Same contract as server.js: newest first, cursor "<iso>|<id>".
      let rows = by(state.history, ["app", "caseId", "platform"]).sort(
        (a, b) => String(b.changedAt).localeCompare(String(a.changedAt)) || String(b._id).localeCompare(String(a._id)),
      );
      const cursor = q("cursor");
      if (cursor) {
        const [at, id] = cursor.split("|");
        rows = rows.filter((r) => String(r.changedAt) < at! || (r.changedAt === at && String(r._id) < id!));
      }
      const limit = Math.min(Math.max(Number(q("limit")) || 100, 1), 500);
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return send(200, { items, nextCursor: rows.length > limit && last ? `${last.changedAt}|${last._id}` : null });
    }
    return send(404, { error: "Cannot GET " + path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
