import { Shield, ChevronRight } from "lucide-react";

interface AdminSection {
  id: string;
  title: string;
  content: string[];
}

const SECTIONS: AdminSection[] = [
  {
    id: "offices",
    title: "Managing Offices",
    content: [
      "Go to Admin > Offices to view all offices. Each office has its own isolated PostgreSQL schema (office_{slug}).",
      "To create a new office, click 'New Office', enter the name and slug. The slug cannot be changed after creation -- choose carefully.",
      "After creating an office in the UI, provision the schema by running: railway run npx tsx scripts/provision-office.ts OFFICE_SLUG=<slug>. This creates the tables, triggers, and indexes for the new office.",
      "Deactivating an office hides it from users but does not delete the data.",
    ],
  },
  {
    id: "users",
    title: "Managing Users",
    content: [
      "Go to Admin > Users to view all users. Users are auto-created on first Microsoft Entra SSO login.",
      "After a user logs in for the first time, assign their role (Admin, Director, or Rep) and verify their primary office.",
      "To give a user access to additional offices (e.g. a director who oversees multiple offices), use the 'Office Access' panel on their user detail page.",
      "Deactivating a user blocks their login immediately. Their data (deals, activities) is preserved.",
    ],
  },
  {
    id: "pipeline",
    title: "Pipeline Configuration",
    content: [
      "Go to Admin > Pipeline to view and edit stage settings.",
      "Stale threshold: the number of days a deal can sit in a stage before triggering a stale alert. Set to blank/null to disable stale alerts for that stage.",
      "Procore mapping: the Procore project status string to set when a deal enters this stage. Leave blank for stages that should not sync to Procore (e.g. DD, Closed Lost).",
      "Color: used in UI badges. Use hex color codes. Recommended: blue for active stages, green for Closed Won, gray for Closed Lost.",
      "Required fields, documents, and approvals are set per stage and enforce stage gate rules. Use the inline stage-gate editor on the Pipeline Configuration page to manage these requirements.",
    ],
  },
  {
    id: "records",
    title: "Lead and Property Records",
    content: [
      "Lead detail pages (/leads/:id) show the pre-RFP record, its timeline, and the conversion handoff into the successor deal.",
      "Property detail pages (/properties/:id) roll up all historical leads and deals tied to the same property and show the related company context.",
      "The property Converted metric is a history proxy: it reflects lead-to-deal conversions, not just currently active work.",
      "If a property or lead needs support review, use the detail page to confirm the source company, address, and related opportunities before escalating.",
    ],
  },
  {
    id: "reporting",
    title: "Unified Workflow Reporting",
    content: [
      "Go to Reports > Unified Workflow Intelligence to review the consolidated lead pipeline, standard pipeline, and service pipeline view.",
      "The workflow overview includes company rollups, rep activity split, stale leads, and stale deals so sales and estimating are reading the same numbers.",
      "The lead-stage versus deal-stage split is based on lead intake activation time, not a hard-coded calendar cutoff.",
      "Saved report presets are additive: existing offices receive missing locked workflow presets without losing their current report setup.",
    ],
  },
  {
    id: "migration",
    title: "Migration Review",
    content: [
      "Go to Admin > Migration Review to resolve unresolved companies, properties, and leads before promotion.",
      "The review queue is paged and surfaces the exception bucket and reason for each staged row.",
      "If an approval fails, the page shows a visible error banner so the operator can correct the row instead of guessing.",
    ],
  },
  {
    id: "procore",
    title: "Procore Sync",
    content: [
      "Go to Admin > Procore Sync to view sync status for all linked projects and change orders.",
      "Synced (green): CRM and Procore agree. Conflict (red): both systems updated the same entity since the last sync -- requires manual resolution.",
      "To resolve a conflict, click 'Resolve' and choose which version to keep.",
      "The Procore sync worker runs every 15 minutes. For immediate sync, use the 'Sync Now' button on the deal detail page (admin only).",
    ],
  },
  {
    id: "audit",
    title: "Audit Log",
    content: [
      "Go to Admin > Audit Log to view the full change history across all tables.",
      "Filter by table, action (insert/update/delete), user, or date range.",
      "Click any row to expand it and see the exact field-level changes (old value to new value).",
      "The audit log is append-only -- rows cannot be modified or deleted. This is enforced at the database level.",
    ],
  },
  {
    id: "env",
    title: "Environment Variables",
    content: [
      "All env vars are managed in Railway's variable settings per service (API, Worker, Frontend).",
      "AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID: Microsoft Entra SSO. When not set, dev mode activates with a user picker.",
      "PROCORE_CLIENT_ID / PROCORE_CLIENT_SECRET / PROCORE_COMPANY_ID: Procore API access.",
      "PROCORE_WEBHOOK_SECRET: HMAC secret for verifying Procore webhook payloads.",
      "SYNCHUB_API_KEY: Shared secret for SyncHub to CRM opportunity push endpoint.",
      "ENCRYPTION_KEY: AES-256-GCM key for encrypting stored API tokens. 32-byte hex string.",
      "R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME: Cloudflare R2 file storage.",
    ],
  },
];

export function AdminGuidePage() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-red-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Admin Guide</h1>
          <p className="text-sm text-gray-500">T Rock CRM -- Administrator Reference</p>
        </div>
      </div>

      <nav className="rounded-lg border bg-gray-50 p-4">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Contents</div>
        <ul className="space-y-1">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
                <ChevronRight className="h-3 w-3" />
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {SECTIONS.map((section) => (
        <div key={section.id} id={section.id} className="scroll-mt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3 border-b pb-2">{section.title}</h2>
          <ul className="space-y-3">
            {section.content.map((para, i) => (
              <li key={i} className="flex gap-3 text-sm text-gray-700">
                <span className="text-red-400 mt-0.5 flex-shrink-0">{"\u2022"}</span>
                <span>{para}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
