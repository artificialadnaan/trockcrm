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

/**
 * How much of each body/subject the QUERY transfers. Defence in depth for the TRANSFER only — the
 * formatter still does the user-visible clamping, and nothing about the rendered note changes.
 *
 * `activities.body` is unbounded `text`, createActivity imposes no length limit, and the API accepts
 * JSON up to 10 MB, so without this a deal with many large activities makes triggering an RFP transfer
 * and materialise megabytes inside the caller's tenant transaction — a pooled client under a 30s
 * statement_timeout, in a repo with a known pool-exhaustion failure mode.
 *
 * MUST stay strictly greater than MAX_BODY_CHARS, and the reason is subtle. The formatter decides
 * "was this clamped?" by `length <= MAX_BODY_CHARS`, so a SQL bound OF exactly MAX_BODY_CHARS would
 * make a 401-character body arrive as 400 and render as though it were complete — silently dropping a
 * character AND its `…` marker. MAX_BODY_CHARS + 1 is the true minimum; the 2x below is headroom.
 *
 * Note the units differ and that is fine: Postgres `left()` counts CHARACTERS while JS `.length`
 * counts UTF-16 code UNITS. Characters ≤ code units always, so any body within the formatter's
 * 400-code-unit limit is at most 400 characters and passes through this bound untouched.
 */
export const ACTIVITY_BODY_SQL_CHAR_LIMIT = MAX_BODY_CHARS * 2;

/**
 * The whitespace BTRIM strips BEFORE the transfer bound is applied, so the characters we transfer are
 * characters of actual CONTENT.
 *
 * This ordering is load-bearing, not tidiness. POST /api/activities stores a body verbatim, so a body
 * beginning with more than ACTIVITY_BODY_SQL_CHAR_LIMIT whitespace characters would otherwise come back
 * as pure whitespace, cleanText would turn that into null, and the entry would render with no body at
 * all. A transfer optimisation must never be able to delete content.
 *
 * The character set is SPELLED OUT because BTRIM's default is a SPACE ONLY — verified, not assumed:
 * `btrim(E'\n\n\thi')` returns the string unchanged. Relying on the default would leave the single most
 * likely real case, a body that starts with newlines, still broken.
 *
 * Every escape here is a documented Postgres E'' escape (`\v` deliberately is not one — an unrecognised
 * escape is taken LITERALLY, which would have put the letter "v" in the trim set and eaten the leading
 * character of a body like "very urgent"). \x0B is the vertical tab; \u00A0 is the non-breaking
 * space that arrives with content pasted out of Outlook or Word. Both are written as ESCAPES rather
 * than literal characters, so the set stays readable in source and reviewable in a diff.
 *
 * The set is a strict SUBSET of what JS `.trim()` removes, which is what keeps the rendered output
 * identical: trimming in SQL and then again in cleanText is the same as trimming once in cleanText.
 * The residual gap is the rest of Unicode's space separators (U+2000–U+200A, U+FEFF, …); losing a body
 * to those needs 800+ CONSECUTIVE leading ones, which is not a shape real input takes.
 */
const SQL_WHITESPACE_TRIM_SET = String.raw`E' \t\n\r\f\x0B\u00A0'`;

/**
 * Ceilings for the note's OTHER unbounded inputs. Without these MAX_NOTE_CHARS is not an invariant:
 * `users.display_name` / `first_name` / `last_name` and `deals.name` are all plain `text` columns, so a
 * single pathological value blows past the total on its own no matter how few entries are emitted.
 */
export const MAX_LABEL_CHARS = 120;
export const MAX_ACTOR_CHARS = 80;
/**
 * `activities.outcome` is `varchar(100)`, so the DB can never exceed this — the clamp is unreachable
 * from the ingest path and is kept only because formatBidBoardActivityNote is an exported PURE function
 * whose `outcome` is typed `string`. It bounds the function's own contract, not the column.
 */
export const MAX_OUTCOME_CHARS = 100;

/**
 * The first line, which is ALSO the idempotency marker SyncHub matches on before posting. SyncHub
 * matches this CONSTANT PREFIX, not the project label or the "as of" date — the label is stable for a
 * given deal but the date is a render-time snapshot, so a re-render must not look like a new note.
 */
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

/**
 * `String.prototype.slice` counts UTF-16 code UNITS, so cutting at an arbitrary index can land BETWEEN
 * the two halves of an astral character — an emoji, a CJK extension — and leave a lone high surrogate
 * at the end. That string has no valid UTF-8 encoding: `JSON.stringify` emits a bare `"\ud83d"` and the
 * `job_queue` INSERT then dies with `invalid input syntax for type json`.
 *
 * Which matters far more than it looks, because of WHERE it fails. loadCrmActivityLog's SAVEPOINT covers
 * the SELECT and the formatter only — the INSERT happens in the caller, OUTSIDE it. So a split pair does
 * not degrade to a null note: it 500s the RFP trigger/approve route and aborts the tenant transaction,
 * which is precisely the failure the savepoint exists to prevent, arriving by a route it cannot see.
 *
 * Every cut in this module therefore goes through here.
 */
function sliceWithoutSplittingPair(value: string, end: number): string {
  const cut = value.slice(0, end);
  // A trailing high surrogate has just lost its low half to the cut — drop it rather than emit it alone.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Clamps a string so the RESULT (the `…` marker included) is at most `max` characters. */
function clampTo(value: string, max: number): string {
  if (value.length <= max) return value;
  return sliceWithoutSplittingPair(value, max - 1) + "…";
}

/** Clamps a body so the RESULT (marker included) is at most MAX_BODY_CHARS characters. */
function clampBody(body: string): string {
  return clampTo(body, MAX_BODY_CHARS);
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
  // estimator should see exactly what the CRM stored. Clamped anyway — the TS type says `string`, and
  // this function must not depend on a column width it cannot see.
  const outcomeText = cleanText(entry.outcome);
  const outcome = outcomeText == null ? null : clampTo(outcomeText, MAX_OUTCOME_CHARS);
  const duration =
    typeof entry.durationMinutes === "number" && Number.isFinite(entry.durationMinutes)
      ? `${entry.durationMinutes} min`
      : null;
  const qualifiers = [outcome, duration].filter((part): part is string => part != null);
  const typeSegment = qualifiers.length > 0 ? `${label} (${qualifiers.join(", ")})` : label;

  // A missing actor drops its segment entirely rather than rendering an empty " · ". The name is an
  // unbounded `text` column, so it is clamped — see MAX_ACTOR_CHARS.
  const actorText = cleanText(entry.actorName);
  const actor = actorText == null ? null : clampTo(actorText, MAX_ACTOR_CHARS);
  const header = [date, typeSegment, actor]
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
    // "1 older entry", not "1 older entries" — an estimator reads this line in Procore. A floor stays
    // plural because "1+" means "at least one", which may well be several.
    const singular = olderCount === 1 && !olderCountIsFloor;
    const count = olderCountIsFloor ? `${olderCount}+` : String(olderCount);
    const noun = singular ? "older entry" : "older entries";
    parts.push(`… ${count} ${noun} not shown (open the deal in the CRM)`);
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
  // The label falls back to `deals.name` upstream, which is unbounded `text` — clamp it, or the heading
  // alone can exceed MAX_NOTE_CHARS no matter how few entries are emitted.
  const label = clampTo(cleanText(input.projectLabel) ?? "Deal", MAX_LABEL_CHARS);
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
  //
  // This sheds all the way to ZERO on purpose. Stopping at one entry left a hole: a single entry that
  // is itself at the cap could still be pushed over by the trailing line, and "the note never exceeds
  // MAX_NOTE_CHARS" has to hold for every input, not just the shapes we expect. A heading-plus-trailer
  // note still tells the estimator there IS history and where to read it.
  while (note.length > MAX_NOTE_CHARS && emitted > 0) {
    emitted -= 1;
    blocks.length = emitted;
    note = renderNote(heading, blocks, entries.length - emitted + knownOlder, olderCountIsFloor);
  }
  // Absolute backstop, so the cap is an INVARIANT rather than an argument about which inputs are
  // bounded. Unreachable once the label/actor/outcome/body clamps above are in place: heading +
  // trailer is a few hundred characters. Slicing keeps the marker (the first line) intact, and goes
  // through the pair-safe cut — a lone surrogate here would fail the job_queue INSERT outside the
  // savepoint, taking the whole RFP with it.
  return note.length > MAX_NOTE_CHARS ? sliceWithoutSplittingPair(note, MAX_NOTE_CHARS) : note;
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
 * SCOPE — matches the CRM's own deal Activity tab (getActivities in modules/activities/service.ts):
 *
 *  - The SOURCE LEAD's activities are included. Nothing re-points `activities.deal_id` at conversion,
 *    so a lead-converted deal's pre-conversion prospecting stays lead-scoped — and that is precisely
 *    the history the estimator wants. The tab ORs in `lead_id` for exactly this reason, and the
 *    sibling loadRfpAttachmentsForDeal already does the same for the lead's FILES.
 *
 *  - `email` activities are EXCLUDED, and this is an ACCESS-CONTROL BOUNDARY, not a formatting
 *    preference. In the CRM those rows are visible only to the mailbox owner (the tab applies
 *    `type <> 'email' OR responsible_user_id = <viewer>`), and their bodies carry up to 1000
 *    characters of real message text lifted from the email body. A Procore Bid Board note has no
 *    "viewer" — every Bid Board user in the company can read it — so the per-viewer rule cannot be
 *    honoured here and the only safe answer is to drop the type entirely. Anything carrying an
 *    `email_id` is dropped too, because the generic createActivity accepts one with any type.
 *    DO NOT "restore completeness" by removing either predicate.
 *
 * Selects `limit + 1` rows so the caller learns whether older entries exist WITHOUT a second COUNT;
 * the extra row is reported as `olderCount: 1, olderCountIsFloor: true` rather than being rendered.
 * Covered by the `activities_deal_idx` / `activities_lead_idx` indexes on (deal_id|lead_id, occurred_at).
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
           -- Bounded in SQL as well as in the formatter, so an unbounded text body cannot make this
           -- query transfer megabytes inside the caller's tenant transaction. Sized above
           -- MAX_BODY_CHARS (see ACTIVITY_BODY_SQL_CHAR_LIMIT) so it can never change what renders:
           -- the formatter's own clamp and its ellipsis marker still do all the user-visible work.
           --
           -- BTRIM runs INSIDE the bound, and the order is the whole point: bodies are stored verbatim,
           -- so bounding first would let a body that opens with more than the limit in whitespace come
           -- back blank and render with no body at all. Trim first and the characters we transfer are
           -- characters of content. See SQL_WHITESPACE_TRIM_SET for why the set is spelled out.
           -- subject is already varchar(500), so its bound is belt-and-braces against a widening.
           LEFT(BTRIM(a.subject, ${sql.raw(SQL_WHITESPACE_TRIM_SET)}), ${ACTIVITY_BODY_SQL_CHAR_LIMIT}) AS "subject",
           LEFT(BTRIM(a.body, ${sql.raw(SQL_WHITESPACE_TRIM_SET)}), ${ACTIVITY_BODY_SQL_CHAR_LIMIT})    AS "body",
           a.outcome           AS "outcome",
           a.duration_minutes  AS "durationMinutes",
           COALESCE(
             NULLIF(btrim(u.display_name), ''),
             NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '')
           )                   AS "actorName"
      FROM activities a
      LEFT JOIN users u ON u.id = COALESCE(a.performed_by_user_id, a.responsible_user_id)
     WHERE (
             a.deal_id = ${dealId}
             -- The source lead's own activities. An uncorrelated scalar subquery so this stays ONE
             -- round trip inside the caller's tenant transaction; a null source_lead_id makes the
             -- comparison null, i.e. false, so a non-converted deal is unaffected.
             OR a.lead_id = (SELECT d.source_lead_id FROM deals d WHERE d.id = ${dealId})
           )
       -- ACCESS-CONTROL BOUNDARY, not a display filter. See this function's doc comment before
       -- touching either of these two lines: email bodies are mailbox-owner-only in the CRM and a
       -- Procore note is readable by every Bid Board user in the company.
       AND a.type <> 'email'
       -- Belt and braces on the same boundary. Every writer in email/service.ts pairs email_id with
       -- type 'email', but the generic createActivity takes an arbitrary emailId with ANY type, so the
       -- type check alone is one careless caller away from leaking a message body.
       AND a.email_id IS NULL
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
