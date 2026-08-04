import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * The app-level cross-office TENANT SCOPE from the URL (?officeId).
 *
 * This is the only office param that selects a schema. api() turns it into the x-office-id header,
 * which tenantMiddleware resolves into a `office_<slug>,public` search_path. Rows a report displays
 * were read under this scope, so a link to one of those rows has to carry it or the detail request
 * lands in the viewer's default schema and 404s a deal that exists only in the scoped one.
 *
 * Deliberately NOT related to ReportFilterBar's `?office`. That is a report PREDICATE evaluated
 * inside the current tenant — it never reaches tenantMiddleware and says nothing about which schema
 * a deal lives in. An earlier revision of the Daily Activity Log resolved `?office` into an officeId
 * for its links and thereby promoted a filter into a tenant switch: the report's office filter matches
 * on an activity's RESPONSIBLE USER (users/offices are public tables, activities/deals are tenant
 * tables), and responsibleUserId is settable by elevated callers, so a Dallas-schema deal can appear
 * under ?office=atlanta. Linking it as ?officeId=atlanta pointed the request at a schema without that
 * deal — the very 404 the link logic exists to prevent.
 *
 * THE RULE, in one line: ?officeId verbatim, or nothing. Never derive it from ?office.
 */
export function useOfficeScopeId(): string | null {
  const [searchParams] = useSearchParams();
  return searchParams.get("officeId");
}

/**
 * Build a /deals/:id href that preserves the current tenant scope.
 *
 * Shared so the rule above lives in ONE place. It previously did not: two separate DealLink
 * components (performance-report-ui and operations-report-common) plus several inline links each
 * built this href by hand, and the shared ones dropped the scope entirely.
 */
export function useDealHref(): (dealId: string) => string {
  const officeId = useOfficeScopeId();
  return useCallback(
    (dealId: string) => `/deals/${dealId}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`,
    [officeId]
  );
}
