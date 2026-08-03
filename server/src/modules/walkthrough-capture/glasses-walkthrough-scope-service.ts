// The deal page's AI-walk panel: every glasses walk filed against a deal, each with whatever scope TROCK
// Scope has extracted from it.
//
// This is a READ, and it sits on a page estimators keep open all day. That single fact decides almost
// everything below: no failure of TROCK Scope — down, slow, refusing the CRM's credential, or answering
// about a walkthrough it has never heard of — may degrade the deal page. Each of those becomes a per-walk
// STATE the panel renders, never a non-200 from this endpoint, and never a wait the user notices.
//
// The four states, and what each one is a claim about:
//   processing    `scope_walkthrough_id` is NULL — the forward has not confirmed a remote walkthrough yet.
//                 A fact from OUR OWN table; no request to TROCK Scope is made at all.
//   ready         TROCK Scope answered. `scope.items` is what it holds, which is legitimately empty for a
//                 walk whose pipeline has not reached consolidation.
//   unavailable   We could not read. 5xx, a refused credential, a connection that never came up, a body we
//                 could not parse, or our own deadline. NOT a claim about the walkthrough — the panel
//                 offers a retry precisely because this says nothing about whether a scope exists.
//   missing       TROCK Scope answered 404 for that id. The one negative claim in the list, and it is
//                 TROCK Scope's claim rather than an inference from silence.
// Conflating `unavailable` with `missing` is the mistake worth naming: "we could not check" is not "it is
// not there" (the same R33 rule the ingest side applies to an object-storage HEAD), and a panel that told
// an estimator their walk had vanished every time Scope restarted would be worse than one that told them
// nothing.
//
// SHAPE OF THE READ, in two exported halves rather than one call, because the route has to COMMIT between
// them. `tenantMiddleware` pins a pooled connection and opens a transaction before any handler runs, and
// there are 20 slots for the whole API (DEFAULT_POOL_MAX, db.ts). Fanning out to TROCK Scope while that
// transaction is open would hold a slot for the entire network wait on a page that is polled — the exact
// cost `GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY` exists to bound on the write side, re-added on the read
// side where the traffic is higher. So: `loadDealGlassesWalkthroughRows` (database), commit, then
// `resolveGlassesWalkthroughScope` (network, no database at all).
import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { glassesWalkthroughs } from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * The ceiling on the WHOLE fan-out, not on one request, and the difference is the point. A per-request
 * ceiling multiplies by the number of walks: five walks against a Scope that is accepting connections and
 * answering none is 25 seconds of a browser waiting on a deal page, from a rule that looks like it bounds
 * things at five. The same reasoning `GLASSES_WALKTHROUGH_VERIFY_TIMEOUT_MS` records on the write side.
 *
 * Five seconds because this is a page render, not a job: TROCK Scope's scope-items read is two indexed
 * selects, so anything approaching this budget means it is unhealthy rather than busy, and the honest
 * answer at that point is a panel that says "unavailable" with a retry — not a spinner.
 */
export const GLASSES_WALKTHROUGH_SCOPE_TIMEOUT_MS = 5_000;

/**
 * How many scope reads may be in flight at once. Bounded because TROCK Scope is one small service and this
 * endpoint is polled by every estimator with a deal open; unbounded, a deal that accumulated walks would
 * open one connection per walk per poll. Generous relative to the number of walks a real deal has (a
 * handful), so in practice the whole fan-out is one round trip wide.
 */
export const GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY = 6;

/** `"processing" | "ready" | "unavailable" | "missing"` — see the module header for what each claims. */
export type GlassesWalkthroughState = "processing" | "ready" | "unavailable" | "missing";

export interface GlassesWalkthroughScopeItem {
  id: string;
  workTypeCode: string | null;
  description: string;
  trade: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number | null;
}

export interface GlassesWalkthroughPanelEntry {
  /** The CRM's own `glasses_walkthroughs.id`, not TROCK Scope's. The panel keys and retries on this. */
  id: string;
  walkId: string;
  scopeWalkthroughId: string | null;
  capturedAt: string;
  capturedByUserId: string | null;
  state: GlassesWalkthroughState;
  scope: { status: "ready"; items: GlassesWalkthroughScopeItem[] } | null;
}

/** One row of `glasses_walkthroughs`, as the database read hands it to the network phase. Named because it
 *  is the seam between the two exported halves — the whole reason the route can commit in between. */
export interface GlassesWalkthroughRow {
  id: string;
  walkId: string;
  scopeWalkthroughId: string | null;
  capturedAt: Date;
  capturedByUserId: string | null;
}

/**
 * TROCK Scope's scope-items read, as a port.
 *
 * Injected rather than imported so this module stays free of `fetch` and of `process.env`, exactly as
 * `GlassesWalkthroughArtifactStore` keeps the ingest module free of the S3 client. The production wiring is
 * `createGlassesWalkthroughScopeReader` (glasses-walkthrough-scope-store.ts).
 *
 * THE THROW/RETURN SPLIT IS THE CONTRACT, and it is the same one the ingest side uses for an object HEAD:
 *   - `{ outcome: "found" }` — TROCK Scope answered about this walkthrough.
 *   - `{ outcome: "missing" }` — TROCK Scope answered 404. A positive claim that it has no such
 *     walkthrough, which only TROCK Scope can make.
 *   - a THROW — anything else: 5xx, a refused credential, a connection that never came up, an unreadable
 *     body, an abort. "We could not read", which must never be reported as "it is not there".
 */
export interface GlassesWalkthroughScopeReader {
  /** Whether the CRM API actually has TROCK Scope credentials. False in local dev and CI — and, until an
   *  operator sets them there, on the deployed API service too, since today only the WORKER carries
   *  `TROCK_SCOPE_BASE_URL` / `TROCK_SCOPE_SERVICE_TOKEN`. An unconfigured reader is reported as
   *  `unavailable` rather than as `missing` or as an empty scope, because that is what it is. */
  isConfigured: () => boolean;
  /**
   * @param signal aborted when the whole-phase deadline fires. Production MUST honour it, for the reason
   *        the ingest store's `head` records: stopping the WAIT without ending the REQUESTS leaves a socket
   *        per abandoned read for the life of the process, and this endpoint is polled — each slow render
   *        would strand another batch on top of the last.
   */
  fetchScopeItems: (
    scopeWalkthroughId: string,
    signal: AbortSignal
  ) => Promise<{ outcome: "found"; items: unknown[] } | { outcome: "missing" }>;
}

/**
 * Every glasses walk filed against this deal, newest first.
 *
 * Deal access is the CALLER'S job (the route asserts it with `assertDealRouteAccess` before this runs),
 * the same division of responsibility every other service in this module keeps. The `deal_id` predicate
 * here is a scoping filter, not an authorisation check, and reading it as one would be the mistake: this
 * function is exported, and a future caller that skipped the assert would still get rows.
 *
 * Ordered by `captured_at` DESC — the walk, not the upload. Those differ by however long the bytes took to
 * drain, which over jobsite cellular is routinely hours, so `created_at` would sort a morning walk under an
 * afternoon one purely because the signal came back later. `id` breaks ties so the order is total: two
 * walks completed inside one clock tick otherwise render in whatever order the scan returned, and a panel
 * that reshuffles between polls reads as data changing.
 */
export async function loadDealGlassesWalkthroughRows(
  tenantDb: TenantDb,
  dealId: string
): Promise<GlassesWalkthroughRow[]> {
  const rows = await tenantDb
    .select({
      id: glassesWalkthroughs.id,
      walkId: glassesWalkthroughs.walkId,
      scopeWalkthroughId: glassesWalkthroughs.scopeWalkthroughId,
      capturedAt: glassesWalkthroughs.capturedAt,
      capturedByUserId: glassesWalkthroughs.capturedByUserId,
    })
    .from(glassesWalkthroughs)
    .where(eq(glassesWalkthroughs.dealId, dealId))
    .orderBy(desc(glassesWalkthroughs.capturedAt), desc(glassesWalkthroughs.id));

  return rows.map((row) => ({
    id: row.id,
    walkId: row.walkId,
    scopeWalkthroughId: row.scopeWalkthroughId ?? null,
    capturedAt: row.capturedAt,
    capturedByUserId: row.capturedByUserId ?? null,
  }));
}

/** A finite JSON number, or null. `Number("")` is 0 and `Number(null)` is 0, so the guard is on the SHAPE
 *  before the coercion — a quantity that arrives as an empty string is "TROCK Scope did not say", not
 *  "zero square feet", and the difference is a line item an estimator would price at nothing. Drizzle
 *  returns `numeric` columns as strings in some configurations, which is why a numeric string is accepted
 *  at all rather than only a number. */
function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * One TROCK Scope scope item narrowed to what the CRM panel renders, or null for one it cannot address.
 *
 * TOLERANT BY FIELD, STRICT ON IDENTITY. TROCK Scope is a separate service on its own release cadence, so
 * this maps defensively rather than trusting a shape: every optional field degrades to null on its own,
 * and only a missing `id` drops the row — because `id` is what the panel keys on and what a future
 * "open this item in Scope" action would address, so an item without one cannot be rendered at all. The
 * alternative, throwing, would turn one malformed row into `unavailable` for the whole walk and hide every
 * good item beside it.
 *
 * `workTypeCode` reads TROCK Scope's `workTypeCode` and falls back to null — NEVER to `workTypeId`, which
 * is what `/scope-items` actually returns today (a uuid FK into its work-type catalog; see
 * shared/src/review/queues.ts in that repo). A uuid displayed in a column labelled with a human work-type
 * code is worse than a blank: it looks like data. This field therefore stays null until TROCK Scope exposes
 * the code on that response, which is a change on that side and is noted in the PR rather than papered over
 * here.
 */
function toPanelScopeItem(raw: unknown): GlassesWalkthroughScopeItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = nonEmptyStringOrNull(item.id);
  if (!id) return null;
  return {
    id,
    workTypeCode: nonEmptyStringOrNull(item.workTypeCode),
    description: typeof item.description === "string" ? item.description : "",
    trade: nonEmptyStringOrNull(item.trade),
    quantity: finiteNumberOrNull(item.quantity),
    unit: nonEmptyStringOrNull(item.unit),
    confidence: finiteNumberOrNull(item.confidence),
  };
}

/**
 * Whether the "TROCK Scope is not configured" line has already been emitted by this process. Module-level
 * rather than per-call because the condition it reports is per-PROCESS: an environment variable does not
 * change under a running API, so repeating the line on every poll of every open deal page is volume
 * without information. Reset by the export below, which exists for tests that need a clean slate.
 */
let warnedUnconfigured = false;
export function __resetGlassesWalkthroughScopeWarningsForTest(): void {
  warnedUnconfigured = false;
}

/**
 * Attach TROCK Scope's answer to each row, and never let one walk's failure reach another's.
 *
 * NO DATABASE WORK HAPPENS HERE. That is what lets the route commit — and release its pooled connection —
 * before this runs; see the module header.
 *
 * THE FAILURE ISOLATION IS STRUCTURAL, not a try/catch bolted on: each walk's outcome is written into its
 * own slot of `entries`, and the workers are TOTAL — every await inside them is inside a try — so the
 * `Promise.all` over them can never reject. That is exactly what makes racing it against the deadline safe:
 * the losing promise cannot become an unhandled rejection after this function has already returned. (The
 * ingest side's `verifyGlassesWalkthroughArtifacts` is shaped the same way and for the same reason; the
 * difference is that there a failure is fatal to the request, and here it is a per-walk state, so nothing
 * stops dispatching on a failure — only on the deadline.)
 *
 * The deadline both STOPS DISPATCHING and ABORTS what is in flight. Doing only the first releases this
 * caller's wait and nothing else: `fetch` has no default timeout, so every read TROCK Scope accepted and
 * did not answer would keep its socket, and because this is a POLLED endpoint the next render stacks a
 * fresh batch on the leaked one. Doing only the second leaves workers free to fire further reads into a
 * service that has already proven it is not answering.
 */
export async function resolveGlassesWalkthroughScope(
  rows: GlassesWalkthroughRow[],
  deps: {
    scopeReader: GlassesWalkthroughScopeReader;
    timeoutMs?: number;
    /** Injected so tests are not noisy and so the production logger can be swapped later. Never given the
     *  reader's error object verbatim in production — see the store, which strips the cause that holds the
     *  request (and therefore the Authorization header). */
    warn?: (message: string) => void;
  }
): Promise<GlassesWalkthroughPanelEntry[]> {
  const timeoutMs = deps.timeoutMs ?? GLASSES_WALKTHROUGH_SCOPE_TIMEOUT_MS;
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const entries: GlassesWalkthroughPanelEntry[] = rows.map((row) => ({
    id: row.id,
    walkId: row.walkId,
    scopeWalkthroughId: row.scopeWalkthroughId,
    capturedAt: row.capturedAt.toISOString(),
    capturedByUserId: row.capturedByUserId,
    // The starting value is the one state that needs no evidence: a row with no scope walkthrough id is
    // "processing" as a fact about our own table, and a row WITH one has not been read yet, so anything
    // that prevents the read from happening at all — an unconfigured reader, the deadline firing before a
    // worker reaches this index — correctly leaves it "unavailable" rather than silently "ready".
    state: row.scopeWalkthroughId ? "unavailable" : "processing",
    scope: null,
  }));

  // Only the rows that have something to ask about. A "processing" walk is answered entirely from our own
  // table, so it must not cost a request — that is the majority state in the minutes after a walk lands,
  // which is precisely when an estimator is watching the panel.
  // Indices into `entries`, not copies of them: the workers write their outcome into the entry itself, so
  // a copy here would leave every state landing on an object the caller never sees.
  const pending = entries.flatMap((entry, index) => (entry.scopeWalkthroughId === null ? [] : [index]));
  if (pending.length === 0) return entries;

  if (!deps.scopeReader.isConfigured()) {
    // Every scope-bearing walk stays `unavailable`, which is the truthful answer: we have no credential,
    // so we know nothing about these walkthroughs. Deliberately not `missing` (that would assert TROCK
    // Scope has no such walkthrough, which we did not ask) and not an empty `ready` scope (that would
    // assert the walk produced no line items, which is the same lie in a friendlier shape).
    //
    // Announced ONCE per process, unlike the per-walk failures below. This endpoint is polled for as long
    // as any estimator has a deal page open, and a missing environment variable is a static fact — the
    // thousandth copy of the line says exactly what the first one did, while burying the failures that
    // differ from each other.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      warn(
        `[glasses-walkthroughs] TROCK Scope is not configured for this API process, so glasses walkthroughs ` +
          `are reported as unavailable. Set TROCK_SCOPE_BASE_URL and TROCK_SCOPE_SERVICE_TOKEN.`
      );
    }
    return entries;
  }

  let stopDispatchingAt = pending.length;
  let nextIndex = 0;
  const abort = new AbortController();
  // Nothing may be written into `entries` once this function has handed it back. A worker whose read
  // settles after the deadline resolved the race would otherwise mutate an object the route has already
  // serialized — invisible today (a late success would write "ready" into a response that has shipped) and
  // a genuinely confusing bug the first time someone holds the array.
  let returned = false;

  const worker = async (): Promise<void> => {
    while (nextIndex < stopDispatchingAt) {
      const entry = entries[pending[nextIndex++]!]!;
      try {
        const answer = await deps.scopeReader.fetchScopeItems(entry.scopeWalkthroughId!, abort.signal);
        if (returned) return;
        if (answer.outcome === "missing") {
          entry.state = "missing";
          continue;
        }
        // `items` may legitimately be empty — a walkthrough whose pipeline has not reached consolidation
        // has no scope rows yet, and that is a walk in progress rather than a walk with nothing in it. The
        // contract distinguishes the two through `state`, not through the length of this array.
        entry.state = "ready";
        entry.scope = {
          status: "ready",
          items: answer.items
            .map((item) => toPanelScopeItem(item))
            .filter((item): item is GlassesWalkthroughScopeItem => item !== null),
        };
      } catch (err) {
        // Left at `unavailable`, with `scope` still null. The message names the WALKTHROUGH, never the
        // reader's error object — see the store for why the underlying rejection is not safe to log.
        if (returned) return;
        entry.state = "unavailable";
        entry.scope = null;
        warn(
          `[glasses-walkthroughs] Could not read the TROCK Scope scope for walk ${entry.walkId}: ` +
            `${err instanceof Error ? err.message : "unknown error"}`
        );
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY, pending.length) }, () => worker())
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          stopDispatchingAt = 0;
          abort.abort();
          resolve();
        }, timeoutMs);
        // Never keep the process alive for a render nobody is waiting on any more.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    returned = true;
  }

  return entries;
}
