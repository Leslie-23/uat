import type { HistoryEntry, ResultRecord, TestCase } from "../api/schemas.js";

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const RECORDED_STATUSES = ["Pass", "Fail", "Blocked", "N/A"] as const;
export type Status = (typeof RECORDED_STATUSES)[number] | "Not run";

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

/** Normalises a stored result to a known status. No record (or an unrecognised value) means "Not run". */
export function statusOf(rec: { result: string | null } | undefined): Status {
  const v = rec?.result;
  return v && (RECORDED_STATUSES as readonly string[]).includes(v) ? (v as Status) : "Not run";
}

export const resultKey = (caseId: string, platform: string) => `${caseId}|${platform}`;

/**
 * Several testers can record the same case; the effective result is the most
 * recently updated record per (case, platform). Same rule as the UAT dashboard.
 */
export function latestPerCase(records: ResultRecord[]): Map<string, ResultRecord> {
  const out = new Map<string, ResultRecord>();
  for (const r of records) {
    const k = resultKey(r.caseId, r.platform);
    const cur = out.get(k);
    if (!cur || time(r.updatedAt) > time(cur.updatedAt)) out.set(k, r);
  }
  return out;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, "medium-high": 2, medium: 3, low: 4 };
export function priorityRank(p: string): number {
  return PRIORITY_RANK[p.trim().toLowerCase()] ?? 5;
}

/** "1. Open the app.\n2. Tap X." → ["Open the app.", "Tap X."] */
export function parseSteps(steps: string): string[] {
  return steps
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\d+[.)]\s*/, ""));
}

/** Loose app/case id matching: case-insensitive, ignores spaces and punctuation ("Tap n Go" → "tapngo"). */
export const normalizeId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function findCase(cases: TestCase[], caseId: string): TestCase | undefined {
  const want = normalizeId(caseId);
  return cases.find((c) => normalizeId(c.id) === want);
}

export interface PlatformHistory {
  platform: string;
  /** Status changes recorded (comment-only edits excluded). */
  statusChanges: number;
  fails: number;
  blocked: number;
  passes: number;
  /** Times the case went from Pass to Fail/Blocked: a regression signal. */
  regressions: number;
  /** Separate runs of Fail/Blocked (consecutive bad results by different testers count once). */
  failEpisodes: number;
  firstFailAt: string | null;
  lastFailAt: string | null;
  lastPassAt: string | null;
  currentStatus: Status;
  testers: string[];
  /** More than one failure episode, i.e. it failed again after being Pass, N/A or re-run. */
  recurring: boolean;
}

/** Summarises a case's history per platform. Entries may be in any order. */
export function analyseHistory(entries: HistoryEntry[]): PlatformHistory[] {
  const byPlatform = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    if (!e.result) continue; // comment-only edit
    const p = e.platform ?? "unknown";
    const list = byPlatform.get(p) ?? [];
    list.push(e);
    byPlatform.set(p, list);
  }
  const out: PlatformHistory[] = [];
  for (const [platform, list] of byPlatform) {
    list.sort((a, b) => time(a.changedAt) - time(b.changedAt));
    const h: PlatformHistory = {
      platform, statusChanges: list.length, fails: 0, blocked: 0, passes: 0, regressions: 0, failEpisodes: 0,
      firstFailAt: null, lastFailAt: null, lastPassAt: null, currentStatus: "Not run", testers: [], recurring: false,
    };
    const testers = new Set<string>();
    let prev: Status = "Not run";
    for (const e of list) {
      const s = statusOf(e);
      if (e.tester) testers.add(e.tester);
      if (s === "Fail" || s === "Blocked") {
        if (s === "Fail") h.fails++; else h.blocked++;
        h.firstFailAt ??= e.changedAt;
        h.lastFailAt = e.changedAt;
        if (prev === "Pass") h.regressions++;
        if (prev !== "Fail" && prev !== "Blocked") h.failEpisodes++;
      } else if (s === "Pass") {
        h.passes++;
        h.lastPassAt = e.changedAt;
      }
      prev = s;
    }
    h.currentStatus = prev;
    h.testers = [...testers];
    h.recurring = h.failEpisodes > 1;
    out.push(h);
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform));
}
