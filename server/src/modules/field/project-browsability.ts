import { sql } from "drizzle-orm";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

// Field "browsable projects" stage rule. The field surface shows ACTIVE-pipeline deals AND Won-family
// terminal deals — crews must find and photograph Won / in-production jobs — but NEVER Lost-family (dead
// jobs). This is the intent-explicit replacement for the old "exclude ALL terminal" rule (which hid Won):
// it deliberately does NOT widen to every terminal stage, which would flood the list with hundreds of
// active Lost deals. `is_active = true` is still required, so only LIVE Won deals surface — the exact set
// the capture-target picker already reaches; archived (is_active=false) Won stay hidden. Both sets come
// from the SHARED canonical slug families (not a hardcoded literal) so omitted alias stages can't drift.
const FIELD_WON_BROWSABLE_SLUGS = WON_STAGE_SLUGS;
const FIELD_LOST_EXCLUDED_SLUGS = LOST_STAGE_SLUGS;

const textArray = (values: readonly string[]) => sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;

/**
 * Canonical visibility predicate for field-browsable projects.
 *
 * This module deliberately stays dependency-light: the corrective-action resend path needs the exact
 * same eligibility rule as the field projects service, but importing that service would also load files,
 * marketing expenses, and lead services into unrelated route tests. Keep this predicate here and re-export
 * it from projects-service for its existing consumers.
 */
export function activeProjectWhere(search?: string) {
  const normalizedSearch = search?.trim();
  const stageSlug = sql`COALESCE(psc.slug, d.bid_board_stage_slug, '')`;
  return sql`
    d.is_active = true
    AND (
      COALESCE(psc.is_terminal, false) = false
      OR ${stageSlug} = ANY(${textArray(FIELD_WON_BROWSABLE_SLUGS)})
    )
    AND ${stageSlug} <> ALL(${textArray(FIELD_LOST_EXCLUDED_SLUGS)})
    ${normalizedSearch ? sql`
      AND (
        d.name ILIKE ${`%${normalizedSearch}%`}
        OR d.deal_number ILIKE ${`%${normalizedSearch}%`}
        -- For HubSpot-imported deals the canonical DFW/ATL number lives in project_number (deal_number
        -- holds the HS- id), so it must be searchable too.
        OR d.project_number ILIKE ${`%${normalizedSearch}%`}
        -- The short accounting title. A change-order child's NAME is the generic "<Parent> — Change
        -- Order N", so the scope phrase a field user actually remembers ("Panel Relocation") lives
        -- only here; without this column that deal is unfindable from the Projects page.
        OR d.scope_title ILIKE ${`%${normalizedSearch}%`}
        OR d.property_address ILIKE ${`%${normalizedSearch}%`}
        OR d.property_city ILIKE ${`%${normalizedSearch}%`}
      )
    ` : sql``}
  `;
}
