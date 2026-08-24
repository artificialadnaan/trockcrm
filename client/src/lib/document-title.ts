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

/**
 * Route → page name, for every STATIC route rendered inside `AppShell`.
 *
 * Keyed off `App.tsx`'s route table rather than the sidebar. The first version of this map used the
 * sidebar's links, which covers what people click but not what the router serves: `/search`,
 * `/sales-review`, `/dashboard/contracts-signed` and `/pipeline/hygiene` had no title at all, and every
 * `/reports/...` page inherited a shared "Reports" — twenty-odd distinct tabs reading identically, which
 * is the defect this whole change exists to remove.
 *
 * Parameterised routes (`/companies/:id`) are deliberately absent: they inherit their section by prefix.
 * A record's own name in the tab needs each page to publish it and is a later refinement.
 */
export const ROUTE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/dashboard": "Dashboard",
  "/dashboard/contracts-signed": "Contracts Signed",

  "/deals": "Deals Dashboard",
  "/deals/board": "Deals Board",
  "/deals/new": "New Deal",
  "/deals/pending-rfp": "Pending RFP",
  "/deals/service-opportunity/new": "New Service Opportunity",

  "/leads": "Leads",
  "/leads/board": "Leads Board",
  "/leads/new": "New Lead",

  "/properties": "Properties",
  "/contacts": "Contacts",
  "/contacts/new": "New Contact",
  "/companies": "Companies",
  "/companies/new": "New Company",

  "/email": "Email",
  "/tasks": "Tasks",
  "/files": "Files",
  "/photos/feed": "Feed",
  "/search": "Search",
  "/sales-review": "Sales Review",
  "/commissions": "Commissions",

  "/pipeline": "Pipeline",
  "/pipeline/hygiene": "Pipeline Hygiene",
  "/pipeline/my-cleanup": "My Cleanup",

  "/projects": "Projects",
  "/projects/qc-reports": "QC Reports",
  "/projects/weekly-reports": "Weekly Reports",
  "/projects/field-team": "Field Team",

  "/director": "Director",
  "/director/commissions": "Team Commissions",

  // Every report is its own page. Leaving them to inherit "Reports" was the defect Codex caught on the
  // first version of this map: twenty-odd distinct report tabs, all named the same, which is the exact
  // problem this change exists to fix.
  "/reports": "Reports",
  "/reports/at-risk": "At-Risk Deals",
  "/reports/region": "Region Report",
  "/reports/rep-pack": "Rep Pack",
  "/reports/monday-showcase": "Monday Showcase",
  "/reports/forecast-confidence": "Forecast Confidence",
  "/reports/analytics/customer-concentration": "Customer Concentration",
  "/reports/analytics/executive-trends": "Executive Trends",
  "/reports/analytics/market-mix": "Market Mix",
  "/reports/operations/estimator-pipeline": "Estimator Pipeline",
  "/reports/operations/portfolio-load": "Portfolio Load",
  "/reports/operations/project-readiness": "Project Readiness",
  "/reports/operations/workflow-bottlenecks": "Workflow Bottlenecks",
  "/reports/performance/canvassing-activity": "Canvassing Activity",
  "/reports/performance/daily-activity-log": "Daily Activity Log",
  "/reports/performance/director-scorecard": "Director Scorecard",
  "/reports/performance/forecast-accuracy": "Forecast Accuracy",
  "/reports/performance/platform-usage": "Platform Usage",
  "/reports/performance/rep-activity": "Rep Activity",
  "/reports/sales/closed-won-revenue": "Closed-Won Revenue",
  "/reports/sales/lead-conversion": "Lead Conversion",
  "/reports/sales/pipeline-velocity": "Pipeline Velocity",

  "/admin/ai-actions": "AI Actions",
  "/admin/ai-ops": "AI Ops",
  "/admin/audit": "Audit Log",
  "/admin/commissions": "Global Commissions",
  "/admin/companycam": "CompanyCam",
  "/admin/cross-office-reports": "Cross-Office Reports",
  "/admin/data-scrub": "Data Scrub",
  "/admin/directory-merge-queue": "Directory Merge Queue",
  "/admin/field-users": "Field Users",
  "/admin/intervention-analytics": "Intervention Analytics",
  "/admin/interventions": "Interventions",
  "/admin/lead-due-diligence-queue": "Lead DD Queue",
  "/admin/merge-queue": "Merge Queue",
  "/admin/migration": "Migration",
  "/admin/migration/contacts": "Migration · Contacts",
  "/admin/migration/deals": "Migration · Deals",
  "/admin/migration/review": "Migration · Review",
  "/admin/notification-recipients": "Notification Recipients",
  "/admin/offices": "Offices",
  "/admin/photo-audit": "Photo Audit",
  "/admin/pipeline": "Pipeline Config",
  "/admin/procore": "Procore Sync",
  "/admin/sales-process-disconnects": "Process Disconnects",
  "/admin/users": "Users",

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
