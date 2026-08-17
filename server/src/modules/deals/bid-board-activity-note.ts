import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Renders a deal's CRM activity history as the plain-text Note SyncHub posts on the Procore Bid Board
 * project it creates from an RFP.
 *
 * Why this exists: the only route by which the CRM creates a Bid Board project is the RFP flow, and the
 * estimator who opens that project in Procore sees none of the sales history — every call, site visit
 * and note the rep logged stays in the CRM. This block carries it over once, at create time.
 *
 * Two exports, one of them pure:
 *  - `loadDealActivityNoteEntries` reads the rows (real SQL, tested against PGlite);
 *  - `formatBidBoardActivityNote` turns them into the note (pure, no DB / no clock / no env).
 *
 * The note is a SNAPSHOT taken when the RFP is triggered — the RFP body is static after trigger (#875) —
 * so activity logged afterwards is deliberately not back-filled.
 */

/** Per-entry body ceiling, applied BEFORE any entry is accumulated. Includes the `…` marker. */
export const MAX_BODY_CHARS = 400;

/** Hard ceiling on how many entries the note can list, newest-first. */
export const MAX_ENTRIES = 40;

/**
 * Hard ceiling on the rendered note. Procore's Notes field imposes an undocumented length limit; this
 * is a deliberate under-guess, and it also keeps the RFP body well clear of SyncHub's 100kb parser
 * limit (see RFP_BODY_BYTE_BUDGET). One constant to tune if the live harness shows a shorter limit.
 */
export const MAX_NOTE_CHARS = 8000;

/**
 * How many activities the producer fetches. Deliberately far above MAX_ENTRIES: the FORMATTER's caps
 * are what should bind, and a generous window is what makes the trailing "… N older entries not shown"
 * count exact rather than a floor for all but the most heavily-logged deals.
 */
export const ACTIVITY_NOTE_FETCH_LIMIT = 200;

/** The first line, which is ALSO the idempotency marker SyncHub matches on before posting. */
const NOTE_HEADING_PREFIX = "CRM Activity Log";

export interface ActivityNoteEntry {
  /** `activities.type` (the enum value, e.g. "site_visit"). */
  type: string;
  occurredAt: Date | string | null;
  subject?: string | null;
  body?: string | null;
  outcome?: string | null;
  durationMinutes?: number | null;
  /** Resolved display name of whoever performed the activity; null renders no actor segment. */
  actorName?: string | null;
}

export interface FormatBidBoardActivityNoteInput {
  /** The deal's FORMATTED number — never a raw HubSpot id or a UUID. Part of the idempotency marker. */
  projectLabel: string;
  /** When the snapshot was taken; rendered as the header's "as of" date. */
  generatedAt: Date;
  /** Newest-first. The formatter does NOT re-sort — the loader's ORDER BY is authoritative. */
  entries: ActivityNoteEntry[];
  /** Older entries the loader KNOWS exist beyond `entries` (0 when `entries` is the whole history). */
  olderCount?: number;
  /**
   * True when `olderCount` is a FLOOR rather than exact — the loader's window filled up, so it only
   * knows "at least this many". Renders "N+ older entries" so the line is never a quiet undercount.
   */
  olderCountIsFloor?: boolean;
}

/**
 * Type labels, mirroring `activityLabels` in client/src/components/activities/entity-activity-tab.tsx so
 * the estimator reads the same words the rep saw when logging. Types absent here (redline_review,
 * go_no_go, follow_up, support_request) fall through to the title-cased raw value.
 */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  call: "Call",
  note: "Note",
  meeting: "Meeting",
  voicemail: "Voicemail",
  lunch: "Lunch",
  site_visit: "Site Visit",
  proposal_sent: "Proposal Sent",
  email: "Email",
  task_completed: "Task Completed",
};

function activityTypeLabel(type: string): string {
  const key = (type ?? "").trim();
  const mapped = ACTIVITY_TYPE_LABELS[key];
  if (mapped) return mapped;
  if (!key) return "Activity";
  return key
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * "Mon DD, YYYY" for the value's America/Chicago calendar day — the SAME business-timezone anchor the
 * hold-horizon rule and the forecast SQL use (shared/src/types/deal-hold-risk.ts). Rendering in UTC
 * would show the wrong calendar day for anything logged after ~7pm CT, which is exactly when a rep
 * writes up the day's calls. DST-safe via Intl; never hand-roll the offset.
 */
function chicagoNoteDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** Clamps a body so the RESULT (marker included) is at most MAX_BODY_CHARS characters. */
function clampBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS - 1) + "…";
}

/** Indents a multi-line block two spaces, leaving blank lines genuinely blank (no trailing spaces). */
function indentBlock(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmedEnd = line.replace(/\s+$/, "");
      return trimmedEnd.length > 0 ? `  ${trimmedEnd}` : "";
    });
}

/** One entry's rendered block: the header line plus its indented subject/body lines. */
function renderEntry(entry: ActivityNoteEntry): string {
  const date = chicagoNoteDate(entry.occurredAt);
  const label = activityTypeLabel(entry.type);

  // Outcome is emitted VERBATIM (trimmed) rather than prettified: it is a free-ish varchar(100) and the
  // estimator should see exactly what the CRM stored.
  const outcome = cleanText(entry.outcome);
  const duration =
    typeof entry.durationMinutes === "number" && Number.isFinite(entry.durationMinutes)
      ? `${entry.durationMinutes} min`
      : null;
  const qualifiers = [outcome, duration].filter((part): part is string => part != null);
  const typeSegment = qualifiers.length > 0 ? `${label} (${qualifiers.join(", ")})` : label;

  // A missing actor drops its segment entirely rather than rendering an empty " · ".
  const header = [date, typeSegment, cleanText(entry.actorName)]
    .filter((part): part is string => part != null && part.length > 0)
    .join(" · ");

  const body = cleanText(entry.body);
  const subject = cleanText(entry.subject);
  const lines = [header];
  // The log form allows a subject AND a body; include the subject only when it adds something, so a
  // form that copied one into the other doesn't print the same sentence twice.
  if (subject && subject !== body) lines.push(...indentBlock(clampBody(subject)));
  if (body) lines.push(...indentBlock(clampBody(body)));
  return lines.join("\n");
}

function renderNote(heading: string, blocks: string[], olderCount: number, olderCountIsFloor: boolean): string {
  const parts = [heading, "", ...blocks];
  if (olderCount > 0) {
    const count = olderCountIsFloor ? `${olderCount}+` : String(olderCount);
    parts.push(`… ${count} older entries not shown (open the deal in the CRM)`);
  }
  return parts.join("\n");
}

/**
 * Builds the Note text. Returns null when the deal has no activity at all — the payload field is then
 * null and SyncHub posts no note, rather than posting an empty heading.
 *
 * Caps are applied in EXACTLY this order so the outcome is deterministic:
 *  1. each body is clamped to MAX_BODY_CHARS (with a `…` marker);
 *  2. entries accumulate newest-first until MAX_ENTRIES **or** MAX_NOTE_CHARS binds, whichever comes first;
 *  3. everything not emitted — including entries dropped by the CHAR cap, not just the entry cap — is
 *     counted into the trailing "… N older entries not shown" line.
 *
 * So MAX_ENTRIES is a ceiling, not a target: a deal with 40 long entries emits fewer than 40 and says so.
 */
export function formatBidBoardActivityNote(input: FormatBidBoardActivityNoteInput): string | null {
  const entries = input.entries ?? [];
  if (entries.length === 0) return null;

  const generatedOn = chicagoNoteDate(input.generatedAt);
  const label = cleanText(input.projectLabel) ?? "Deal";
  const heading = generatedOn
    ? `${NOTE_HEADING_PREFIX} — ${label} (as of ${generatedOn})`
    : `${NOTE_HEADING_PREFIX} — ${label}`;

  const knownOlder = Math.max(0, input.olderCount ?? 0);
  const olderCountIsFloor = input.olderCountIsFloor === true;

  // +1 for the blank line under the heading. Measured against the rendered note, so the char cap
  // accounts for indentation and separators rather than raw body length.
  let used = heading.length + 1;
  const blocks: string[] = [];
  for (const entry of entries) {
    if (blocks.length >= MAX_ENTRIES) break;
    const block = renderEntry(entry);
    const cost = block.length + 1; // +1 for the newline joining it to the previous line
    if (used + cost > MAX_NOTE_CHARS) break;
    used += cost;
    blocks.push(block);
  }

  let emitted = blocks.length;
  let note = renderNote(heading, blocks, entries.length - emitted + knownOlder, olderCountIsFloor);
  // The trailing line's own length is not knowable until we know how many entries were dropped, so it
  // can push a note that just fit back over the cap. Give up entries from the tail until it fits again.
  // Unreachable for realistic input (heading + one 400-char body + trailer is well under 8000) — this
  // exists so "the note is never longer than MAX_NOTE_CHARS" is an invariant rather than a hope.
  while (note.length > MAX_NOTE_CHARS && emitted > 1) {
    emitted -= 1;
    blocks.length = emitted;
    note = renderNote(heading, blocks, entries.length - emitted + knownOlder, olderCountIsFloor);
  }
  return note;
}

export interface LoadDealActivityNoteEntriesResult {
  /** Newest-first, at most `limit` rows. */
  entries: ActivityNoteEntry[];
  /** Additional older entries known to exist beyond `entries`. */
  olderCount: number;
  /** True when `olderCount` is a floor (the window filled up), so callers can render "N+". */
  olderCountIsFloor: boolean;
}

/**
 * Loads a deal's activity history for the note, newest-first.
 *
 * Selects `limit + 1` rows so the caller learns whether older entries exist WITHOUT a second COUNT;
 * the extra row is reported as `olderCount: 1, olderCountIsFloor: true` rather than being rendered.
 * Covered by the `activities_deal_idx` index on (deal_id, occurred_at).
 *
 * Actor: `performed_by_user_id` when set, else `responsible_user_id` (the NOT NULL column). The name
 * resolution mirrors resolveDealOwner in rfp-enqueue.ts — displayName → first+last → null.
 *
 * `users` is intentionally unqualified: it lives in `public` and resolves through the tenant
 * search_path, the same way loadRfpPayloadDeal's joins do.
 */
export async function loadDealActivityNoteEntries(
  tenantDb: TenantDb,
  dealId: string,
  limit: number = ACTIVITY_NOTE_FETCH_LIMIT
): Promise<LoadDealActivityNoteEntriesResult> {
  const windowSize = Math.max(0, Math.floor(limit));
  if (windowSize === 0) return { entries: [], olderCount: 0, olderCountIsFloor: false };

  const result = await tenantDb.execute(sql`
    SELECT a.type::text        AS "type",
           a.occurred_at       AS "occurredAt",
           a.subject           AS "subject",
           a.body              AS "body",
           a.outcome           AS "outcome",
           a.duration_minutes  AS "durationMinutes",
           COALESCE(
             NULLIF(btrim(u.display_name), ''),
             NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '')
           )                   AS "actorName"
      FROM activities a
      LEFT JOIN users u ON u.id = COALESCE(a.performed_by_user_id, a.responsible_user_id)
     WHERE a.deal_id = ${dealId}
     -- created_at/id break occurred_at ties so two same-instant activities can never swap order
     -- between the payload and a later re-render.
     ORDER BY a.occurred_at DESC, a.created_at DESC, a.id DESC
     LIMIT ${windowSize + 1}
  `);
  const rows = (Array.isArray(result) ? result : result.rows ?? []) as Array<Record<string, any>>;
  const hasMore = rows.length > windowSize;

  return {
    entries: rows.slice(0, windowSize).map((row) => ({
      type: (row.type as string | null) ?? "",
      occurredAt: (row.occurredAt as Date | string | null) ?? null,
      subject: (row.subject as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      outcome: (row.outcome as string | null) ?? null,
      durationMinutes:
        row.durationMinutes == null ? null : Number(row.durationMinutes),
      actorName: (row.actorName as string | null) ?? null,
    })),
    olderCount: hasMore ? 1 : 0,
    olderCountIsFloor: hasMore,
  };
}
