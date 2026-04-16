import { BookOpen, ChevronRight } from "lucide-react";

interface Section {
  id: string;
  title: string;
  content: string[];
}

const SECTIONS: Section[] = [
  {
    id: "login",
    title: "Logging In",
    content: [
      "Go to the CRM URL and click \"Sign in with Microsoft\". Use your T Rock Microsoft 365 account (same credentials as Outlook).",
      "Your role (Rep, Director, or Admin) is assigned by your CRM administrator. Contact them if you can't access certain features.",
      "If you have access to multiple offices, use the office switcher in the sidebar to change your active office.",
    ],
  },
  {
    id: "pipeline",
    title: "Managing Deals",
    content: [
      "The Pipeline view (/pipeline) shows all your active deals as a Kanban board. Deals are grouped by stage.",
      "Drag a deal card to advance it to the next stage. If the stage requires approval or has missing fields, you'll see a checklist of what's needed before you can advance.",
      "The DD column (Due Diligence) is separate from the main pipeline. Toggle \"Show DD\" to include/exclude it.",
      "To close a deal as Lost, move it to the Closed Lost column. A modal will ask for a reason and optional notes -- both are required.",
    ],
  },
  {
    id: "leads",
    title: "Leads",
    content: [
      "Lead pages (/leads/:id) show pre-RFP work before it becomes a deal. Use them to review scoping context, contact links, and the lead timeline.",
      "When a lead converts, the successor deal keeps the history linked back to the lead so you do not lose the earlier activity trail.",
      "If the lead is still active, the page makes that clear so you know whether the work belongs in pre-RFP or deal-stage follow-up.",
    ],
  },
  {
    id: "properties",
    title: "Properties",
    content: [
      "Property pages (/properties/:id) roll up every historical lead and deal tied to the same property.",
      "Use the property page when a company has multiple locations or multiple opportunities at the same address and you need the full history in one place.",
      "The Converted metric on the property page is a history proxy for lead-to-deal conversion, not just the currently active open work.",
    ],
  },
  {
    id: "deals",
    title: "Deal Detail",
    content: [
      "Click any deal to open the detail view. Tabs: Overview, Files, Email, Timeline, History.",
      "The Overview tab shows estimates (DD / Bid / Awarded), contact list, property info, and the stage advancement panel.",
      "Deal detail timelines include the linked pre-RFP lead history so conversion history stays visible after the handoff.",
      "To log a call, note, or meeting: use the activity buttons in the Overview tab. All activities appear in the Timeline tab.",
      "Files uploaded to a deal are automatically named using the deal number, category, and date (e.g. TR-2026-0142_Photo_2026-04-15_001.jpg).",
    ],
  },
  {
    id: "contacts",
    title: "Contact Directory",
    content: [
      "The Contacts page (/contacts) is a searchable directory of all contacts in your office.",
      "When creating a contact, the system checks for duplicate emails (hard block) and similar names (warning). Use the suggested existing contact if it already exists.",
      "Each contact shows their touchpoint count, last contacted date, and active deals. Touchpoints are logged automatically when you log a call, email, or meeting.",
    ],
  },
  {
    id: "email",
    title: "Email",
    content: [
      "Your CRM inbox (/email) shows emails from contacts in the CRM -- not your full Outlook inbox. Only emails from known contacts are synced.",
      "Inbound emails are automatically associated using deal number, thread history, deal, lead, and property context in that order. If the system still cannot choose safely, the email is attached to the company and a task is created for deal assignment.",
      "The manual assignment queue is deal-only. Use it to resolve the email to the correct deal when the system cannot do it automatically.",
      "To send an email from the CRM, open a deal or contact and click \"Compose\". Emails sent from the CRM are logged in your activity feed.",
    ],
  },
  {
    id: "tasks",
    title: "Tasks",
    content: [
      "Your task list (/tasks) is generated daily. Overdue tasks appear at the top in red.",
      "System-generated tasks include: stale deal alerts, follow-up reminders, inbound emails needing deal assignment, and pending approvals.",
      "Mark a task complete by clicking the checkbox. Dismissed tasks are hidden but not deleted -- use the 'Show dismissed' toggle to view them.",
    ],
  },
  {
    id: "search",
    title: "Global Search",
    content: [
      "Press Cmd+K (Mac) or Ctrl+K (Windows) to open global search from any page.",
      "Search across deals, contacts, and files simultaneously. Results are ranked by relevance.",
      "Recent searches are saved locally and appear when you open the search palette with an empty query.",
    ],
  },
  {
    id: "reports",
    title: "Reports",
    content: [
      "Use Reports > Unified Workflow Intelligence to see the combined lead pipeline, standard pipeline, service pipeline, company rollups, stale leads, and stale deals.",
      "The workflow overview is meant to keep sales and estimating aligned on the same operational numbers.",
      "If you are checking whether a rep is active, use the rep activity split in the workflow overview rather than counting notes by hand.",
    ],
  },
  {
    id: "migration",
    title: "Migration Review",
    content: [
      "If you are helping clean up an import, unresolved records are reviewed under Admin > Migration Review.",
      "The queue can include companies, properties, and leads that need manual review before promotion.",
      "Rows can fail approval with a visible banner message, so if something does not promote, review the bucket and the reason before trying again.",
    ],
  },
];

export function UserGuidePage() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <BookOpen className="h-7 w-7 text-blue-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">User Guide</h1>
          <p className="text-sm text-gray-500">T Rock CRM -- Sales Rep Guide</p>
        </div>
      </div>

      <nav className="rounded-lg border bg-gray-50 p-4">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Contents
        </div>
        <ul className="space-y-1">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <ChevronRight className="h-3 w-3" />
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {SECTIONS.map((section) => (
        <div key={section.id} id={section.id} className="scroll-mt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3 border-b pb-2">
            {section.title}
          </h2>
          <ul className="space-y-3">
            {section.content.map((para, i) => (
              <li key={i} className="flex gap-3 text-sm text-gray-700">
                <span className="text-blue-400 mt-0.5 flex-shrink-0">{"\u2022"}</span>
                <span>{para}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
        Need help? Contact your CRM administrator for support.
      </div>
    </div>
  );
}
