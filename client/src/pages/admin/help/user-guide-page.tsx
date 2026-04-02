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
    id: "deals",
    title: "Deal Detail",
    content: [
      "Click any deal to open the detail view. Tabs: Overview, Files, Email, Timeline, History.",
      "The Overview tab shows estimates (DD / Bid / Awarded), contact list, property info, and the stage advancement panel.",
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
      "Inbound emails are automatically associated to the contact's most recent active deal. If a contact has multiple active deals, you'll get a task asking you to assign the email manually.",
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
