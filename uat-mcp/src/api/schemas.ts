import { z } from "zod";

/*
 * Response shapes of the UAT Tracker REST API (server.js), as they are today.
 * Optional/nullable wherever the backend doesn't guarantee a field, so older
 * records don't break parsing. Unknown extra fields are dropped.
 */

const text = z.string().nullish().transform((v) => v ?? "");
const optText = z.string().nullish().transform((v) => v ?? null);

export const AuthResponse = z.object({
  token: z.string().min(1),
  role: z.string(),
});

/** testcases collection: seeded from seed_data.json; `_id` equals the case id. */
export const TestCase = z
  .object({
    id: z.string().optional(),
    _id: z.string().optional(),
    app: z.string(),
    module: text,
    scenario: text,
    steps: text,
    expected: text,
    priority: text,
    order: z.number().nullish().transform((v) => v ?? 0),
  })
  .transform((c) => ({
    id: c.id ?? c._id ?? "",
    app: c.app,
    module: c.module,
    scenario: c.scenario,
    steps: c.steps,
    expected: c.expected,
    priority: c.priority,
    order: c.order,
  }))
  .refine((c) => c.id !== "", { message: "test case has no id" });
export type TestCase = z.infer<typeof TestCase>;

/**
 * results collection: one record per (caseId, platform, tester).
 * `result` is free text server-side; the UI writes Pass | Fail | Blocked | N/A.
 * `comments` is the tester's free-text note (the closest thing to an "actual result").
 */
export const ResultRecord = z.object({
  caseId: z.string(),
  app: z.string(),
  platform: z.string(),
  tester: optText,
  result: optText,
  comments: optText,
  updatedAt: optText,
});
export type ResultRecord = z.infer<typeof ResultRecord>;

/** attachments collection, list view (image bytes excluded by the server). Screenshots only. */
export const Attachment = z.object({
  _id: z.string(),
  caseId: z.string(),
  app: z.string(),
  platform: optText,
  tester: optText,
  filename: optText,
  mimeType: optText,
  createdAt: optText,
});
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentImage = z.object({
  image: z.string(),
  mimeType: optText,
});
export type AttachmentImage = z.infer<typeof AttachmentImage>;

/** history collection: append-only, one entry per save. `result` is null for comment-only edits. */
export const HistoryEntry = z.object({
  _id: z.string().optional(),
  caseId: z.string(),
  app: z.string(),
  platform: optText,
  tester: optText,
  result: optText,
  comments: optText,
  changedAt: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** GET /api/history (read-only, tester role). */
export const HistoryPage = z.object({
  items: z.array(HistoryEntry),
  nextCursor: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

/**
 * acceptances collection: an admin can accept (lock) a case+platform once its result
 * is confirmed. While locked, nobody can change its result, notes or screenshots.
 */
export const Acceptance = z.object({
  app: z.string(),
  caseId: z.string(),
  platform: z.string(),
  accepted: z.boolean().nullish().transform((v) => v === true),
  acceptedAt: optText,
});
export type Acceptance = z.infer<typeof Acceptance>;

/** comments collection: app-level notes, not tied to a case. */
export const AppNote = z.object({
  app: z.string(),
  tester: optText,
  text: z.string(),
  createdAt: optText,
});
export type AppNote = z.infer<typeof AppNote>;
