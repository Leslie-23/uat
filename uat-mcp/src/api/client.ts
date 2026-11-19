import { z } from "zod";
import type { Config } from "../config.js";
import * as S from "./schemas.js";

/** An error talking to the UAT API, with a message written for the agent/user. */
export class UatApiError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "UatApiError";
  }
}

type Query = Record<string, string | number | undefined>;
type FetchLike = typeof globalThis.fetch;

const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const CASE_CACHE_MS = 60_000;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number, res?: Response): number {
  const retryAfter = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000);
  return 300 * 2 ** attempt + Math.floor(Math.random() * 100);
}

function networkError(e: unknown, baseUrl: string): UatApiError {
  const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return new UatApiError(
    timedOut
      ? `The UAT server at ${baseUrl} didn't respond in time. It may be cold-starting; try again shortly.`
      : `Couldn't reach the UAT server at ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
    timedOut ? "timeout" : "network",
  );
}

async function httpError(res: Response, path: string): Promise<UatApiError> {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      detail = body.slice(0, 200);
    }
  } catch {
    /* ignore */
  }
  if (res.status === 401) return new UatApiError("The UAT session was rejected. Check UAT_PASSPHRASE.", "not_authenticated", 401);
  if (res.status === 403) return new UatApiError(`${path} requires a role this server doesn't have (${detail || "forbidden"}).`, "forbidden", 403);
  if (res.status === 404) return new UatApiError(`${path} was not found on the UAT server.`, "not_found", 404);
  return new UatApiError(`UAT API ${path} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}.`, "http_error", res.status);
}

/**
 * Read-only client for the UAT Tracker REST API.
 * Apart from logging in (and out), it only issues GET requests: there are no write methods.
 */
export class UatClient {
  private token: string | null = null;
  private loggingIn: Promise<string> | null = null;
  private caseCache = new Map<string, { at: number; value: S.TestCase[] }>();
  /** Role of the current session ("tester" | "admin"), once signed in. */
  role: string | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  private url(path: string, query?: Query): string {
    const u = new URL(this.cfg.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private login(): Promise<string> {
    if (!this.loggingIn) {
      this.loggingIn = (async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(this.url("/api/auth"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ password: this.cfg.passphrase }),
            signal: AbortSignal.timeout(this.cfg.timeoutMs),
          });
        } catch (e) {
          throw networkError(e, this.cfg.baseUrl);
        }
        if (res.status === 401) {
          throw new UatApiError(
            "The UAT server rejected UAT_PASSPHRASE. Check it matches the current tester passphrase (an admin may have changed it).",
            "auth_failed",
            401,
          );
        }
        if (!res.ok) throw await httpError(res, "/api/auth");
        const parsed = S.AuthResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw new UatApiError("The UAT server returned an unexpected login response.", "bad_response", res.status);
        this.role = parsed.data.role;
        if (parsed.data.role === "admin") {
          this.log("[uat-mcp] Warning: signed in with the ADMIN passphrase. The tester passphrase is enough for this read-only server.");
        }
        this.token = parsed.data.token;
        return parsed.data.token;
      })().finally(() => {
        this.loggingIn = null;
      });
    }
    return this.loggingIn;
  }

  /** GET with auth, one re-login on 401, retries with backoff on network errors / 5xx / 429, and schema validation. */
  private async get<T extends z.ZodType>(path: string, schema: T, query?: Query): Promise<z.output<T>> {
    let reauthed = false;
    let attempt = 0;
    for (;;) {
      const token = this.token ?? (await this.login());
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path, query), {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt++));
          continue;
        }
        throw networkError(e, this.cfg.baseUrl);
      }
      if (res.status === 401 && !reauthed) {
        // Session gone (e.g. sessions were cleared): sign in again once.
        reauthed = true;
        this.token = null;
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt++, res));
        continue;
      }
      if (!res.ok) throw await httpError(res, path);

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new UatApiError(`${path} returned a response that isn't JSON.`, "bad_response", res.status);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new UatApiError(
          `${path} returned data in an unexpected shape: ${z.prettifyError(parsed.error).slice(0, 600)}`,
          "bad_response",
          res.status,
        );
      }
      return parsed.data;
    }
  }

  /** All test cases, or one app's, in plan order. Cached briefly: the test plan rarely changes. */
  async listTestCases(app?: string): Promise<S.TestCase[]> {
    const key = app ?? "*";
    const hit = this.caseCache.get(key);
    if (hit && Date.now() - hit.at < CASE_CACHE_MS) return hit.value;
    const value = await this.get("/api/testcases", z.array(S.TestCase), { app });
    value.sort((a, b) => a.order - b.order);
    this.caseCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Every tester's result records, optionally filtered by app and platform. */
  listResults(q: { app?: string; platform?: string } = {}): Promise<S.ResultRecord[]> {
    return this.get("/api/results", z.array(S.ResultRecord), q);
  }

  /** Screenshot metadata (no image bytes), newest first. */
  listAttachments(q: { app: string; caseId?: string; platform?: string }): Promise<S.Attachment[]> {
    return this.get("/api/attachments", z.array(S.Attachment), q);
  }

  /** One screenshot's bytes (base64) and MIME type. */
  getAttachmentImage(id: string): Promise<S.AttachmentImage> {
    if (!OBJECT_ID.test(id)) return Promise.reject(new UatApiError(`"${id}" is not a valid attachment id.`, "invalid_id"));
    return this.get(`/api/attachments/${id}/image`, S.AttachmentImage);
  }

  /** One page of change history, newest first. Needs the read-only GET /api/history endpoint on the server. */
  async listHistory(q: { app?: string; caseId?: string; platform?: string; limit?: number; cursor?: string }): Promise<S.HistoryPage> {
    try {
      return await this.get("/api/history", S.HistoryPage, q);
    } catch (e) {
      if (e instanceof UatApiError && e.status === 404) {
        throw new UatApiError(
          "This UAT deployment doesn't have the read-only history endpoint (GET /api/history) yet. Deploy the latest server.js to enable get_test_history.",
          "history_unavailable",
          404,
        );
      }
      throw e;
    }
  }

  /** App-level notes (newest first, max 200 server-side). */
  listNotes(app: string): Promise<S.AppNote[]> {
    return this.get("/api/comments", z.array(S.AppNote), { app });
  }

  /** Best-effort sign-out so sessions don't pile up on the server. Never throws. */
  async close(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (!token) return;
    try {
      await this.fetchImpl(this.url("/api/logout"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      /* older deployments have no /api/logout; nothing to do */
    }
  }
}
