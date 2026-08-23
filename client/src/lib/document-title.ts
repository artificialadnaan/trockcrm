/**
 * Per-route page titles.
 *
 * Until this existed, `client/index.html` set a static `<title>` and nothing in the app ever wrote
 * `document.title` — so every tab, every history entry and every bookmark in the CRM read "T Rock CRM".
 * WCAG 2.2 SC 2.4.2 "Page Titled" is the compliance name for it; the daily cost is four identical tabs
 * when you have a company, a property, a deal and its weekly report open at once.
 *
 * TITLES MIRROR THE SIDEBAR'S LABELS, deliberately: the tab should say what the user clicked. The map is
 * a second list of the same routes, so `document-title.test.ts` parses `sidebar.tsx` and fails if either
 * list gains an entry the other lacks — adding a nav item without a title would otherwise reintroduce the
 * untitled-tab bug for that one page, which is the hardest kind to notice.
 */

export const APP_NAME = "T Rock CRM";

/** Route → page name. Keys are the sidebar's `to` values; every internal one must appear here. */
export const ROUTE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/deals": "Deals Dashboard",
  "/leads": "Leads",
  "/properties": "Properties",
  "/contacts": "Contacts",
  "/companies": "Companies",
  "/email": "Email",
  "/tasks": "Tasks",
  "/files": "Files",
  "/photos/feed": "Feed",
  "/reports": "Reports",
  "/commissions": "Commissions",
  "/projects": "Projects",
  "/projects/qc-reports": "QC Reports",
  "/projects/weekly-reports": "Weekly Reports",
  "/projects/field-team": "Field Team",
  "/deals/pending-rfp": "Pending RFP",
  "/director": "Director",
  "/director/commissions": "Team Commissions",
  "/admin/sales-process-disconnects": "Process Disconnects",
  "/admin/interventions": "Interventions",
  "/admin/intervention-analytics": "Intervention Analytics",
  "/admin/lead-due-diligence-queue": "Lead DD Queue",
  "/admin/merge-queue": "Merge Queue",
  "/admin/directory-merge-queue": "Directory Merge Queue",
  "/admin/notification-recipients": "Notification Recipients",
  "/admin/ai-actions": "AI Actions",
  "/admin/ai-ops": "AI Ops",
  "/admin/offices": "Offices",
  "/admin/users": "Users",
  "/admin/field-users": "Field Users",
  "/admin/pipeline": "Pipeline Config",
  "/admin/commissions": "Global Commissions",
  "/admin/procore": "Procore Sync",
  "/admin/data-scrub": "Data Scrub",
  "/admin/audit": "Audit Log",
  "/admin/cross-office-reports": "Cross-Office Reports",
  "/admin/migration": "Migration",
  "/help/user-guide": "User Guide",
  "/help/admin-guide": "Admin Guide",
};

/**
 * The document title for a pathname.
 *
 * PAGE FIRST, because a tab strip truncates from the right — "T Rock CRM · Deals" collapses to
 * "T Rock CR…" and is exactly as useless as the static title it replaced.
 *
 * Longest-prefix match, so `/companies/abc-123` becomes "Companies · T Rock CRM" rather than falling back
 * to the bare app name. That is deliberately a SECTION title, not a record one: putting the record's name
 * in the tab needs each page to publish it, and the prefix match makes that a later refinement instead of
 * a rewrite.
 *
 * The prefix must end on a SEGMENT boundary. A plain `startsWith` lets `/deals` claim `/dealsroom`, and
 * `/` claim everything — which is why the root is exact-match only.
 */
export function titleForPath(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/") return `${ROUTE_TITLES["/"]} · ${APP_NAME}`;

  let best: string | null = null;
  let bestLength = 0;
  for (const [route, name] of Object.entries(ROUTE_TITLES)) {
    if (route === "/") continue;
    const matches = normalized === route || normalized.startsWith(`${route}/`);
    if (matches && route.length > bestLength) {
      best = name;
      bestLength = route.length;
    }
  }
  return best ? `${best} · ${APP_NAME}` : APP_NAME;
}
