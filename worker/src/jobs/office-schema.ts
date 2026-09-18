/**
 * Resolve the tenant schema a job should write into.
 *
 * MOVED OUT OF jobs/index.ts so it is importable. It was a module-local function there, which meant
 * any handler living outside that file had to grow its own copy — and the copy that
 * task-notifications.ts grew resolved the RECIPIENT'S HOME OFFICE instead of the office the event
 * happened in. One exported definition is what stops that recurring.
 *
 * ⚠️ THE EVENT'S officeId WINS, AND THE USER IS ONLY A FALLBACK. `public.users` is GLOBAL while
 * `notifications`, `tasks` and the rest of the tenant tables are PER-OFFICE, so "the office this user
 * belongs to" and "the office this event happened in" are two different questions. In a single-office
 * deployment they have the same answer, which is exactly why code that conflates them looks correct
 * and is only correct by coincidence. Resolving from the user writes the row into a schema the user
 * never reads and the linked record does not live in.
 *
 * The event's office id is real and already plumbed: queue.ts passes `job.office_id` into every
 * handler, and the API sets it from the writer's ACTIVE office when it enqueues. The user lookup
 * survives only for a legacy row enqueued before that column was populated — dropping the job
 * entirely would be a worse answer than delivering it to the recipient's home office.
 *
 * WHY NOT payload.tenantSchema. The email jobs in this directory (rfp-rejection-email,
 * field-scorecard-email, won-metric-reduction-alert, …) do read `payload.tenantSchema` and validate it
 * with `isSafeTenantSchema`, but those are enqueued by Postgres TRIGGERS, which have no office UUID to
 * hand and DO know their own `TG_TABLE_SCHEMA`. `domain_event` jobs are the opposite: they are
 * enqueued by the API with `office_id` set, and the whole domainEventHandlers map is typed
 * `(payload, officeId)`. Carrying a `tenantSchema` on those payloads too would put a SECOND
 * representation of the same fact on the row, and two representations can disagree. Deriving the
 * schema from the one authority — the office id — cannot.
 *
 * The slug regex is the injection guard, and it is not optional: a schema name cannot be a bind
 * parameter, so the resolved slug is interpolated into the caller's SQL.
 */
export type OfficeSchemaPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }>;
};

export async function resolveOfficeSchema(
  pool: OfficeSchemaPool,
  officeId: string | null,
  userId?: string | null
): Promise<{ officeId: string; schemaName: string } | null> {
  let resolvedOfficeId = officeId;

  if (!resolvedOfficeId && userId) {
    const userRes = await pool.query("SELECT office_id FROM public.users WHERE id = $1", [userId]);
    resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
  }

  if (!resolvedOfficeId) return null;

  const officeResult = await pool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [resolvedOfficeId]
  );
  if (officeResult.rows.length === 0) return null;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return null;

  return {
    officeId: resolvedOfficeId,
    schemaName: `office_${slug}`,
  };
}
