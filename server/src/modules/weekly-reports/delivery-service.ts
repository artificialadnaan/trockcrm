import {
  weeklyReportDeliverySupersedes,
  type WeeklyReportDeliveryEvent,
} from "@trock-crm/shared/lib/weeklyReportDelivery";
import { pool } from "../../db.js";
import { withWeeklyReportOfficeClient } from "./office-connection.js";
import type { QueryExecutor } from "./projects-service.js";

// Ingesting what the mail provider said about a send, after the send was over.
//
// The send path can only ever observe ACCEPTANCE — `send_delivered_at` — and that is where it stops. This
// module is the other half: a webhook arrives minutes or hours later saying the message was delivered,
// bounced or reported as spam, and this turns it into a fact on the report row.
//
// THREE THINGS MAKE IT AWKWARD, and each shapes the code below.
//
//   1. NO OFFICE CONTEXT. The request has no session, no header and no tenant hint. The office comes from
//      `public.weekly_report_send_deliveries`, keyed on the delivery key the message was tagged with —
//      one indexed lookup, not a scan across every schema.
//
//   2. NO ORDER. Webhooks are retried and can overtake one another, so "the last one we saw" is not the
//      answer; the provider's own event timestamp is. The rule lives in `weeklyReportDeliverySupersedes`
//      so it can be tested without a database, and it is applied under a row lock so two events racing
//      through two connections cannot both read the old verdict and both write.
//
//   3. NO CALLER. Nobody is watching the response. A failure here is not reported to a human by anything,
//      which is why the correlation is on a key that cannot be reconstructed wrongly and why the write is
//      conditioned on that same key rather than on the report id alone.
//
// WHAT IT DOES NOT TOUCH: `send_delivered_at`, whose meaning is unchanged and still "accepted"; and
// `updated_at`, which is the PDF artifact's cache generation (see pdf-artifact.ts). Bumping the latter
// would invalidate the stored PDF of every report the moment its delivery receipt arrived and re-render
// it — every photo downloaded and transcoded again — to record something that is not in the document.
//
// THE VERDICT IS PER MESSAGE, NOT PER RECIPIENT, and that is a real limit rather than a simplification.
// One send goes to every client contact that has an address (DOC, PM, RM, CM) plus `SYSTEM_EMAIL_BCC`,
// and the provider reports one event for the message — so `bounced` here means "at least one address on
// this message was refused", not "the client got nothing", and a bounce of the internal monitoring bcc is
// indistinguishable from a bounce of the client's own address. Both are recorded the same way ON PURPOSE:
// the surfaces say the provider reported it as not delivered and point the PM at the addresses on the
// project, which is the right action in every one of those cases. Reading the provider's per-recipient
// detail would need `data.to` to carry which address failed, and it does not.

/** Where a report lives, resolved from a delivery key alone. */
export interface WeeklyReportDeliveryTarget {
  deliveryKey: string;
  weeklyReportId: string;
  tenantId: string;
  officeSlug: string;
}

/**
 * Register a send request's delivery key against its office.
 *
 * Called from `sendWeeklyReport` inside the SAME transaction as the `approved -> sent` transition, so a
 * report that is `sent` always has a row here. Getting this wrong in the other direction is the failure
 * that matters: a send whose key was never registered is a send whose bounce arrives, resolves to nothing,
 * and is dropped — the exact silence this feature exists to end.
 *
 * ON CONFLICT DO NOTHING because a retry replays the SAME key by design (that is what stops it becoming a
 * second email), so a second insert is the normal case and not an error.
 */
export async function registerWeeklyReportSendDelivery(
  client: QueryExecutor,
  input: { deliveryKey: string; weeklyReportId: string; tenantId: string; officeSlug: string },
): Promise<void> {
  await client.query(
    `INSERT INTO public.weekly_report_send_deliveries
       (delivery_key, weekly_report_id, tenant_id, office_slug)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
     ON CONFLICT (delivery_key) DO NOTHING`,
    [input.deliveryKey, input.weeklyReportId, input.tenantId, input.officeSlug],
  );
}

/** Resolve a delivery key to its office and report. `null` for a key this platform never minted. */
export async function resolveWeeklyReportDeliveryTarget(
  client: QueryExecutor,
  deliveryKey: string,
): Promise<WeeklyReportDeliveryTarget | null> {
  const result = await client.query(
    `SELECT delivery_key, weekly_report_id, tenant_id, office_slug
       FROM public.weekly_report_send_deliveries
      WHERE delivery_key = $1::uuid
      LIMIT 1`,
    [deliveryKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    deliveryKey: row.delivery_key,
    weeklyReportId: row.weekly_report_id,
    tenantId: row.tenant_id,
    officeSlug: row.office_slug,
  };
}

export type WeeklyReportDeliveryOutcome =
  /** The verdict on the row is now this event's. */
  | "applied"
  /** A verdict the provider dated later is already there. Includes an exact replay of this same event. */
  | "superseded"
  /** No row matches this key — the report was hard-deleted, or the key has been rotated out from under it. */
  | "unmatched";

/**
 * Apply one event to one report, inside the caller's transaction.
 *
 * THE `send_delivery_key` PREDICATE IS THE VERSION ISOLATION, and it is worth being explicit about why the
 * report id is not enough on its own. A correction is a different report ROW with a different key, so a
 * bounce on v1 and a delivery on v2 can never meet; but the registry row and the report row are two
 * separate facts, and conditioning the write on both means a key that has somehow moved writes nothing
 * rather than writing to whatever the id now points at.
 *
 * Locked with FOR UPDATE because the decision is read-then-write. Two events for the same send arriving on
 * two connections — which is exactly what a provider retry alongside a fresh event looks like — would
 * otherwise both read the old verdict and both pass the supersede test, and the loser would land last.
 */
export async function applyWeeklyReportDeliveryEvent(
  client: QueryExecutor,
  input: { weeklyReportId: string; deliveryKey: string; event: WeeklyReportDeliveryEvent },
): Promise<WeeklyReportDeliveryOutcome> {
  const locked = await client.query(
    `SELECT id, send_delivery_status, send_delivery_status_at
       FROM weekly_reports
      WHERE id = $1::uuid AND send_delivery_key = $2::uuid AND is_active
      FOR UPDATE`,
    [input.weeklyReportId, input.deliveryKey],
  );
  const row = locked.rows[0];
  if (!row) return "unmatched";

  const supersedes = weeklyReportDeliverySupersedes(
    { status: row.send_delivery_status, occurredAt: row.send_delivery_status_at },
    { status: input.event.status, occurredAt: input.event.occurredAt },
  );
  if (!supersedes) return "superseded";

  // `send_delivered_at` is NOT in this list and never will be. It means "the provider accepted the
  // message", the board / History chip / retry gate / weekly_reports_send_undelivered_idx all read it with
  // that meaning, and a bounce does not make the acceptance untrue — it makes it insufficient, which is
  // what the columns below are for. `updated_at` is absent for a different reason: it is the PDF cache
  // generation, and a delivery receipt is not a change to the document.
  await client.query(
    `UPDATE weekly_reports
        SET send_delivery_status = $3,
            send_delivery_status_at = $4::timestamptz,
            send_delivery_detail = $5::jsonb
      WHERE id = $1::uuid AND send_delivery_key = $2::uuid AND is_active`,
    [
      input.weeklyReportId,
      input.deliveryKey,
      input.event.status,
      input.event.occurredAt,
      JSON.stringify(input.event.detail),
    ],
  );
  return "applied";
}

export interface IngestWeeklyReportDeliveryDeps {
  /** The `public` lookup. Defaults to the plain pool — the registry is not tenant-scoped. */
  publicClient?: QueryExecutor;
  /** Injected so the runtime suite can run the whole ingest against one PGlite instance. */
  withOfficeClient?: typeof withWeeklyReportOfficeClient;
}

export type WeeklyReportDeliveryIngestResult =
  | { outcome: WeeklyReportDeliveryOutcome; target: WeeklyReportDeliveryTarget }
  /** The key resolves to nothing we minted. Not an error, and NOT distinguishable from outside. */
  | { outcome: "unknown_key"; target: null };

/**
 * Resolve, lock, decide, write — the whole ingest for one verified event.
 *
 * Returns an outcome rather than a status code. The route deliberately answers the same thing whatever
 * comes back: telling a caller apart on "we have never heard of that delivery key" hands anybody with the
 * endpoint a way to enumerate which keys exist, and the keys are uuids attached to client correspondence.
 */
export async function ingestWeeklyReportDeliveryEvent(
  event: WeeklyReportDeliveryEvent,
  deps: IngestWeeklyReportDeliveryDeps = {},
): Promise<WeeklyReportDeliveryIngestResult> {
  const publicClient = deps.publicClient ?? { query: pool.query.bind(pool) };
  const target = await resolveWeeklyReportDeliveryTarget(publicClient, event.deliveryKey);
  if (!target) return { outcome: "unknown_key", target: null };

  const withOfficeClient = deps.withOfficeClient ?? withWeeklyReportOfficeClient;
  const outcome = await withOfficeClient(target.officeSlug, {}, (client) =>
    applyWeeklyReportDeliveryEvent(client, {
      weeklyReportId: target.weeklyReportId,
      deliveryKey: target.deliveryKey,
      event,
    }),
  );
  return { outcome, target };
}
