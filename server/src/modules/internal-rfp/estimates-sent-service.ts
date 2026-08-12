// The deals that went out to a client in a window — the CRM half of SyncHub's RFP Report email.
//
// WHY THIS EXISTS AT ALL. SyncHub composes and sends the "T-Rock RFP Report" (server/rfp-reports.ts in
// trocksynchubv3, on a report_schedule_config cron). It knows about RFPs only because the CRM PUSHED them:
// the two systems are joined by HMAC-signed callbacks, not by a shared database. `estimate_sent_to_client`
// is a CRM pipeline stage recorded in deal_stage_history inside each office's tenant schema, and SyncHub
// has no read path to it. So the report asks for it, at compose time, through this feed.
//
// PULL, NOT PUSH — deliberately. The report is a point-in-time snapshot sent once a day, so the durability
// machinery a push would need (an outbox, retries, dedup, a backfill for anything sent before the feature
// existed) buys nothing: a missed event would still be visible to the next pull. And the annotation the
// report wants — how many times this deal has been sent to the client BEFORE — is a question about the
// deal's whole history, which a per-event push would have to reconstruct from events it may never have seen.
//
// WHICH STAGES COUNT. SENT_STAGE_SLUGS, the reports' own canonical set, rather than the single obvious
// slug. It carries `service_estimate_sent_to_client` (the service pipeline's parallel stage) and `bid_sent`
// (the pre-migration-0053 name, still referenced by historical deal_stage_history rows). Naming only
// `estimate_sent_to_client` here would quietly omit every service deal from the email while the reports
// counted them — two numbers for the same question, which is how people stop trusting both.
//
// EVERY ENTRY, NOT THE FIRST. A deal re-enters this stage whenever a revised estimate goes out, and each of
// those is a real send worth reporting. `priorEntryCount` says how many times it had been sent before this
// one, so a re-send reads as a re-send rather than as new business.

import { SENT_STAGE_SLUGS } from "../reports/foundations.js";
import { aliasedDealBestEstimateSqlText } from "../shared/deal-value-sql.js";

/** A minimal query shape, so this is injectable in tests (pool.query, a PGlite query, or a mock all fit). */
export type SqlQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface EstimateSentDeal {
  dealId: string;
  officeSlug: string;
  name: string | null;
  dealNumber: string | null;
  projectNumber: string | null;
  /** The stage actually entered — the service pipeline and the legacy alias are distinguishable downstream. */
  stageSlug: string;
  /** When it entered, ISO-8601 UTC. The report renders it in its own timezone. */
  enteredAt: string;
  /** Awarded-first best estimate, the same basis the reports quote. Never null; 0 when nothing is set. */
  amount: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Sends of THIS deal strictly before this one. 0 on a first send, 2 on a third. */
  priorEntryCount: number;
}

const TENANT_SCHEMA_REGEX = /^office_[a-z][a-z0-9_]*$/;

export function quoteSchema(schemaName: string): string {
  if (!TENANT_SCHEMA_REGEX.test(schemaName)) {
    throw new Error(`Refusing to query a non-tenant schema: ${schemaName}`);
  }
  return `"${schemaName}"`;
}

/**
 * One office's sends in [from, to).
 *
 * HALF-OPEN on purpose. A closed upper bound double-counts anything landing exactly on the boundary into
 * two consecutive daily reports — rare, but it makes the two emails disagree about the same deal, and the
 * reader has no way to tell which is right.
 */
export function estimatesSentQuery(schemaName: string): string {
  const schema = quoteSchema(schemaName);
  const slugList = SENT_STAGE_SLUGS.map((slug) => `'${slug}'`).join(", ");
  return `
    SELECT d.id::text                            AS deal_id,
           d.name                                AS name,
           d.deal_number                         AS deal_number,
           d.project_number                      AS project_number,
           ps.slug                               AS stage_slug,
           h.created_at                          AS entered_at,
           ${aliasedDealBestEstimateSqlText("d")} AS amount,
           -- The SAME owner priority the RFP half of this email already uses (resolveDealOwner):
           -- assigned rep -> synced HubSpot owner email -> deal creator. assigned_rep_id is nullable
           -- (migration 0042), so keying on it alone printed an em-dash for deals the rest of the very
           -- same report can name. Tier 2 keeps the rep's display name when one exists but carries no
           -- email, exactly as resolveDealOwner does.
           CASE
             WHEN u.email IS NOT NULL THEN u.display_name
             WHEN NULLIF(BTRIM(d.hubspot_owner_email), '') IS NOT NULL THEN u.display_name
             ELSE cu.display_name
           END                                   AS owner_name,
           COALESCE(u.email, NULLIF(BTRIM(d.hubspot_owner_email), ''), cu.email) AS owner_email,
           (SELECT COUNT(*)
              FROM ${schema}.deal_stage_history ph
              JOIN public.pipeline_stage_config pps ON pps.id = ph.to_stage_id
             WHERE ph.deal_id = d.id
               AND pps.slug IN (${slugList})
               AND ph.created_at < h.created_at)::int AS prior_entry_count
      FROM ${schema}.deal_stage_history h
      -- Stages are a PUBLIC table, not a tenant one: deal_stage_history and deals live per-office, the
      -- stage catalogue is shared. Joining a per-schema pipeline_stages would resolve to nothing.
      JOIN public.pipeline_stage_config ps ON ps.id = h.to_stage_id
      JOIN ${schema}.deals d               ON d.id = h.deal_id
      LEFT JOIN public.users u             ON u.id = d.assigned_rep_id
      LEFT JOIN public.users cu            ON cu.id = d.created_by_user_id
     WHERE ps.slug IN (${slugList})
       AND h.created_at >= $1
       AND h.created_at <  $2
       -- Soft-deleted deals are excluded, matching every report. On-hold deals are NOT: the estimate did
       -- go out, and parking the deal afterwards does not un-send it. Test rows never appear, and neither
       -- does a send attributed to a test user.
       AND d.is_active = true
       AND COALESCE(d.is_test_data, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.users tu WHERE tu.id = d.assigned_rep_id AND tu.is_test_data = true)
       -- …and the same exclusion for whoever the FALLBACK chain actually selected, at EVERY tier.
       -- Checking only the assigned rep let a deal with no rep through carrying a test user's identity —
       -- via the synced HubSpot address, or via the creator — which contradicts this feed's own "test rows
       -- never appear" rule. Each clause fires only when that tier is the one supplying the owner.
       AND NOT (
             u.email IS NULL
         AND NULLIF(BTRIM(d.hubspot_owner_email), '') IS NOT NULL
         AND EXISTS (
               SELECT 1 FROM public.users hu
                WHERE LOWER(hu.email) = LOWER(BTRIM(d.hubspot_owner_email))
                  AND hu.is_test_data = true
             )
       )
       AND NOT (
             COALESCE(cu.is_test_data, false) = true
         AND u.email IS NULL
         AND NULLIF(BTRIM(d.hubspot_owner_email), '') IS NULL
       )
     ORDER BY h.created_at DESC, d.id DESC`;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

/**
 * Every office's sends in the window, newest first.
 *
 * Swept across schemas because the report is company-wide — SyncHub has no office context and the email has
 * never had one. `officeSlug` rides along on each row so a reader can still tell them apart.
 */
export async function loadEstimatesSent(
  query: SqlQuery,
  schemaNames: readonly string[],
  from: Date,
  to: Date
): Promise<EstimateSentDeal[]> {
  const collected: EstimateSentDeal[] = [];

  for (const schemaName of schemaNames) {
    const result = await query(estimatesSentQuery(schemaName), [from.toISOString(), to.toISOString()]);
    for (const row of result.rows) {
      collected.push({
        dealId: String(row.deal_id),
        officeSlug: schemaName.replace(/^office_/, ""),
        name: row.name ?? null,
        dealNumber: row.deal_number ?? null,
        projectNumber: row.project_number ?? null,
        stageSlug: String(row.stage_slug),
        enteredAt: toIso(row.entered_at),
        // Rendered as a STRING. These are numeric(12,2) columns; a JS number silently rounds past 2^53 and,
        // more practically, turns 1234567.89 into a float the email would print with a drifting cent.
        amount: String(row.amount ?? "0"),
        ownerName: row.owner_name ?? null,
        ownerEmail: row.owner_email ?? null,
        priorEntryCount: Number(row.prior_entry_count ?? 0),
      });
    }
  }

  // Re-sorted ACROSS offices. Each per-schema query is ordered, but concatenating them would group by
  // office and read as though every Dallas send preceded every Atlanta one.
  collected.sort((a, b) => {
    const delta = Date.parse(b.enteredAt) - Date.parse(a.enteredAt);
    return delta !== 0 ? delta : a.dealId.localeCompare(b.dealId);
  });
  return collected;
}

/** Upper bound on the window a single request may ask for, so a bad `from` cannot sweep all of history. */
export const MAX_WINDOW_DAYS = 31;

/** Days in a given month, so 2026-02-30 can be refused on its own terms rather than after normalisation. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * ISO-8601 instant, validated COMPONENT BY COMPONENT before any offset is applied.
 *
 * `new Date(String(x))` is far too permissive to guard a window with: a JSON number 0 stringifies to "0"
 * and parses as 2000-01-01, and "2026-02-30T00:00:00Z" normalises to March 2 — so a caller with a
 * date-construction bug would get a SUCCESSFUL report covering a period it never asked for, which is
 * worse than the 422 it should have received.
 *
 * Checking the parsed instant's round-trip is not enough on its own, and an earlier revision of this
 * function got that wrong: a non-UTC offset legitimately shifts the calendar day, so the round-trip was
 * skipped whenever the input did not end in `Z` — which exempted every explicit-offset timestamp from
 * the check. "2026-02-30T00:00:00-05:00" and "2026-08-06T24:00:00-05:00" both normalise silently and
 * both were accepted. Validating year/month/day/hour/minute/second as WRITTEN settles it for every
 * offset, because those components mean the same thing before the offset is applied.
 */
function parseIsoInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value.trim()
    );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;

  // Postgres has no year zero: it parses here and then fails at the ::date cast as a 500 where the route
  // means to answer 400. The report service's own isRealIsoDate rejects 0000 for the same reason.
  if (year < 1) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseWindow(payload: Record<string, unknown>): { from: Date; to: Date } {
  const from = parseIsoInstant(payload.from);
  const to = parseIsoInstant(payload.to);
  if (!from || !to) {
    throw new Error("from and to must be ISO-8601 timestamps");
  }
  if (to <= from) {
    throw new Error("to must be after from");
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(`window must not exceed ${MAX_WINDOW_DAYS} days`);
  }
  return { from, to };
}
