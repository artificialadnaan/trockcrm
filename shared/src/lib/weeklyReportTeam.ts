/**
 * How a weekly-report project's T-Rock project manager and superintendent are resolved — ONE definition,
 * shared by the API and the worker.
 *
 * A project points at each of them twice:
 *
 *   trock_*_responder_id — the `field_responders` roster row. WHO this person is. The list a director
 *                          curates on the deal Team tab and the QC scorecards pick from.
 *   trock_*_user_id      — the `public.users` login, derived from that roster row's email at write time,
 *                          or NULL when the person has no CRM account. WHAT AUTHORISES them: this is the
 *                          column `isAssignedPm` compares against the acting user to decide who may
 *                          approve and send.
 *
 * The roster wins for the NAME and the ADDRESS, because it is the curated list and the one the client PDF
 * is expected to match. The login is the fallback for setups made before the roster link existed, and for
 * the elevated staff who carry a project without appearing on the field roster.
 *
 * `is_active` follows the SAME precedence rather than being OR-ed together: once a roster row exists, a
 * director deactivating it means that person is off the job, and a still-valid login must not override
 * that decision.
 *
 * WHY THIS LIVES IN `shared`. These columns are read by six queries across two deployables — the
 * dashboard, the setup list, the send composer and the PDF renderer in `server`, plus the reminder job
 * and the dead-letter sweep in `worker`. The worker cannot import from the server package, so a helper
 * there would have had to be copy-pasted. Six copies of a COALESCE is exactly how a PDF ends up printing
 * a name that the reminder email disagrees with.
 *
 * These emit SQL FRAGMENTS, not whole queries, and interpolate only a caller-supplied table alias — never
 * user input. `assertSafeAlias` keeps that true by construction rather than by convention.
 */

/**
 * Aliases are compile-time constants at every call site today. Enforced anyway: this function's output is
 * concatenated into SQL, so the day someone threads a variable through here, it fails loudly instead of
 * becoming an injection point.
 */
function assertSafeAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Unsafe SQL alias for the weekly-report team joins: ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * The six resolved columns. Pair with {@link trockTeamJoins} bound to the same alias.
 *
 * No leading or trailing comma — callers place it in their select list themselves, because some need it
 * first and some need columns after it.
 */
export function trockTeamColumns(): string {
  return `         COALESCE(pm_fr.name, pm_u.display_name)     AS trock_pm_name,
         COALESCE(pm_fr.email, pm_u.email)           AS trock_pm_email,
         COALESCE(pm_fr.is_active, pm_u.is_active)   AS trock_pm_is_active,
         COALESCE(sup_fr.name, sup_u.display_name)   AS trock_super_name,
         COALESCE(sup_fr.email, sup_u.email)         AS trock_super_email,
         COALESCE(sup_fr.is_active, sup_u.is_active) AS trock_super_is_active`;
}

/**
 * The four LEFT JOINs {@link trockTeamColumns} reads from.
 *
 * All four are LEFT: an unassigned slot, a roster row with no login, and a login with no roster row are
 * each ordinary states, and an inner join on any of them would silently drop the project from the
 * dashboard rather than showing it as unassigned.
 *
 * @param alias  the alias the `weekly_report_projects` row is bound to in the caller's FROM clause.
 * @param schema the tenant schema to qualify `field_responders` with. OMIT IT in the API, whose tenant
 *   client runs with a per-office `search_path`; PASS IT in the worker, which holds no search_path and
 *   spells out `office_x.<table>` at every site. Getting this wrong does not fail quietly: unqualified in
 *   the worker resolves to nothing and the join errors, which is the outcome to prefer over silently
 *   reading another office's roster.
 */
export function trockTeamJoins(alias: string, schema?: string): string {
  const a = assertSafeAlias(alias);
  const responders = schema ? `${assertSafeAlias(schema)}.field_responders` : "field_responders";
  return `       LEFT JOIN ${responders} pm_fr  ON pm_fr.id  = ${a}.trock_pm_responder_id
       LEFT JOIN ${responders} sup_fr ON sup_fr.id = ${a}.trock_super_responder_id
       LEFT JOIN public.users pm_u    ON pm_u.id   = ${a}.trock_pm_user_id
       LEFT JOIN public.users sup_u   ON sup_u.id  = ${a}.trock_super_user_id`;
}
