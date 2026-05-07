import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Edit,
  ExternalLink,
  Plus,
  MoreHorizontal,
  Phone,
  Mail,
  Calendar,
  Star,
  Handshake,
  Activity,
  FileText,
  StickyNote,
  Briefcase,
  Building2,
  ClipboardList,
  Hash,
  Headphones,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD, MetricCard, ActivityTimeline, DetailTabs } from "./preview-shared";
import { EmailList, RecordingsList, type EmailRow, type RecordingRow } from "./comms-preview";
import { FilesView, type PhotoItem, type DocumentItem } from "./files-preview";

const fixture = {
  id: "1",
  name: "Marcus Holloway",
  title: "Director of Facilities",
  company: "Dallas Independent SD",
  companyId: "1",
  role: "Decision Maker",
  primary: true,
  phone: "(214) 555-0102",
  mobile: "(214) 555-0188",
  email: "mholloway@dallasisd.org",
  linkedin: "linkedin.com/in/marcusholloway",
  hubspotId: "hs_contact_88112",
  about:
    "20-year district veteran. Owns capital projects > $500K. Known for direct, no-fluff communication. Prefers in-person walkthroughs over phone calls. Sons attend Skyline.",
  ownerInitials: "BR",
  ownerName: "Brett Rios",
  metrics: {
    linkedDeals: 2,
    linkedDealValue: 1_115_000,
    lastTouch: "today",
  },
  deals: [
    { id: "1", name: "Dallas ISD Roof Replacement", stage: "Estimating", days: 22, sla: 14, value: 875_000 },
    { id: "d12", name: "Dallas ISD Service Contract", stage: "Contract", days: 6, sla: 14, value: 240_000 },
  ],
  activity: [
    { id: "a1", icon: "phone", who: "Brett Rios", what: "Called re: SOV revision · 12 min", when: "2h ago" },
    { id: "a2", icon: "mail", who: "Marcus Holloway", what: "Sent revised RFP attachments", when: "yesterday" },
    { id: "a3", icon: "calendar", who: "Brett Rios", what: "Site walk scheduled · Building A", when: "2 days ago" },
    { id: "a4", icon: "note", who: "Brett Rios", what: "Note: prefers in-person, calls direct", when: "1 week ago" },
    { id: "a5", icon: "mail", who: "Brett Rios", what: "Followed up on intro email", when: "2 weeks ago" },
  ],
  emails: [
    { id: "e1", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "RE: Building A roof phase 2 timeline", preview: "Confirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting...", date: "2h ago", unread: true, hasAttachment: true, attachmentCount: 2 },
    { id: "e2", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Updated SOV - Dallas ISD Bldg A", preview: "Marcus, attached the revised SOV with the drain replacement line items broken out. Let me know if the procurement office needs additional...", date: "yesterday", hasAttachment: true, attachmentCount: 1 },
    { id: "e3", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "Site walk Friday morning", preview: "Brett, Friday at 8:30am works on my end. I'll meet you at the north entrance. Let's plan 90 minutes — I want to walk the parapet and...", date: "3 days ago" },
    { id: "e4", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Re: Bid pricing strategy", preview: "Looped in Takashi on this one. We're going to come in 6% under last year's benchmark with phased mobilization to keep their budget...", date: "5 days ago" },
    { id: "e5", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "Pre-bid Q&A doc", preview: "Drafted the pre-bid Q&A based on the walkthrough notes. Let me know if anything needs to be added before procurement publishes...", date: "1 week ago", hasAttachment: true, attachmentCount: 1 },
  ] satisfies EmailRow[],
  recordings: [
    { id: "r1", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 754, date: "2h ago", hasTranscript: true, transcript: "...so the bid timeline locks in mid-June. Your team can start submittals as soon as the board approves on the 28th...", topics: ["Bid timeline", "Phasing", "Submittals"] },
    { id: "r2", contactName: "Marcus Holloway", contactInitials: "MH", direction: "inbound", durationSeconds: 412, date: "3 days ago", hasTranscript: true, transcript: "Brett, Marcus. Got time to talk through the parapet question on Building A? I want to make sure the SOV reflects what we walked...", topics: ["Site walk", "SOV"] },
    { id: "r3", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 1840, date: "5 days ago", hasTranscript: true, transcript: "Walked through the bid pricing strategy. Marcus is comfortable with phased mobilization. Action items: revised SOV by Friday...", topics: ["Pricing", "Strategy", "Action items"] },
    { id: "r4", contactName: "Marcus Holloway", contactInitials: "MH", direction: "inbound", durationSeconds: 263, date: "2 weeks ago", hasTranscript: false, transcript: "" },
  ] satisfies RecordingRow[],
  photos: [
    { id: "p1", label: "Site walk · roof south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p2", label: "Site walk · parapet", takenBy: "BR", takenAt: "2 days ago" },
  ] satisfies PhotoItem[],
  documents: [
    { id: "d1", name: "Updated SOV - Bldg A.pdf", kind: "Estimate", sizeKB: 980, uploadedBy: "BR", uploadedAt: "yesterday" },
    { id: "d2", name: "Building A - RFP packet.pdf", kind: "RFP", sizeKB: 4_320, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
    { id: "d3", name: "Pre-bid Q&A draft.pdf", kind: "Spec", sizeKB: 240, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
  ] satisfies DocumentItem[],
};

type TabKey = "overview" | "deals" | "email" | "recordings" | "activity" | "notes" | "files";

const TABS = [
  { key: "overview" as TabKey, label: "Overview", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "deals" as TabKey, label: "Linked deals", icon: <Handshake className="h-4 w-4" />, count: fixture.deals.length },
  { key: "email" as TabKey, label: "Email", icon: <Mail className="h-4 w-4" />, count: fixture.emails.length },
  { key: "recordings" as TabKey, label: "Recordings", icon: <Headphones className="h-4 w-4" />, count: fixture.recordings.length },
  { key: "activity" as TabKey, label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "notes" as TabKey, label: "Notes", icon: <StickyNote className="h-4 w-4" /> },
  { key: "files" as TabKey, label: "Files", icon: <FileText className="h-4 w-4" />, count: fixture.photos.length + fixture.documents.length },
];

function ActivityIcon({ kind }: { kind: string }) {
  const map: Record<string, typeof Phone> = {
    phone: Phone,
    mail: Mail,
    calendar: Calendar,
    note: StickyNote,
  };
  const Icon = map[kind] ?? Activity;
  const tone =
    kind === "phone"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : kind === "mail"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : kind === "calendar"
          ? "bg-violet-50 text-violet-700 ring-violet-200"
          : "bg-amber-50 text-amber-700 ring-amber-200";
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function ContactDetailPreview() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");
  const initials = fixture.name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => navigate("/contacts")}
          className="flex items-center gap-1 font-semibold text-slate-500 hover:text-brand-red"
        >
          <ArrowLeft className="h-3 w-3" />
          Contacts
        </button>
        <ChevronRight className="h-3 w-3 text-slate-300" />
        <p className="font-bold text-slate-950">{fixture.name}</p>
      </div>

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-brand-red text-2xl font-black uppercase text-white shadow-[0_2px_0_rgba(153,0,0,0.4)]">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className={EYEBROW}>{fixture.role}</p>
              {fixture.primary ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                  <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
                  Primary
                </span>
              ) : null}
            </div>
            <h1 className="mt-1 text-3xl font-black uppercase tracking-tight text-slate-950 md:text-4xl">
              {fixture.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className="font-semibold">{fixture.title}</span>
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <button
                type="button"
                onClick={() => navigate(`/companies/${fixture.companyId}`)}
                className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red"
              >
                <Briefcase className="h-3.5 w-3.5" />
                {fixture.company}
              </button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm">
            <Phone className="mr-1 h-4 w-4" />
            Call
          </Button>
          <Button variant="outline" size="sm">
            <Mail className="mr-1 h-4 w-4" />
            Email
          </Button>
          <Button size="sm">
            <Calendar className="mr-1 h-4 w-4" />
            Schedule
          </Button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Linked deals"
          value={String(fixture.metrics.linkedDeals)}
          badge={USD(fixture.metrics.linkedDealValue)}
          badgeTone="green"
          caption="Active pipeline"
          accent="red"
        />
        <MetricCard
          eyebrow="Last touch"
          value={fixture.metrics.lastTouch}
          badge="phone call"
          badgeTone="blue"
          caption="Within today"
          accent="blue"
        />
        <MetricCard
          eyebrow="Engagement"
          value="High"
          badge="responsive"
          drenched
          caption="Responded < 4hr avg"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <Card>
          <DetailTabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === "overview" ? (
            <div className="space-y-6 p-6">
              <section>
                <p className={EYEBROW}>About</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{fixture.about}</p>
              </section>

              <section className="grid gap-3 sm:grid-cols-2">
                <a
                  href={`tel:${fixture.phone}`}
                  className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50/40 p-4 transition-colors hover:bg-slate-100"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                    <Phone className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Office</p>
                    <p className="truncate text-sm font-semibold text-slate-950">{fixture.phone}</p>
                  </div>
                </a>
                <a
                  href={`tel:${fixture.mobile}`}
                  className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50/40 p-4 transition-colors hover:bg-slate-100"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                    <Phone className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Mobile</p>
                    <p className="truncate text-sm font-semibold text-slate-950">{fixture.mobile}</p>
                  </div>
                </a>
                <a
                  href={`mailto:${fixture.email}`}
                  className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50/40 p-4 transition-colors hover:bg-slate-100 sm:col-span-2"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-50 text-blue-700 ring-1 ring-blue-200">
                    <Mail className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Email</p>
                    <p className="truncate text-sm font-semibold text-slate-950">{fixture.email}</p>
                  </div>
                </a>
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between">
                  <p className={EYEBROW}>Recent activity</p>
                  <button
                    type="button"
                    onClick={() => setTab("activity")}
                    className="text-xs font-bold uppercase tracking-wide text-brand-red hover:underline"
                  >
                    See all
                  </button>
                </div>
                <ActivityTimeline
                  items={fixture.activity.slice(0, 4)}
                  renderIcon={(k) => <ActivityIcon kind={k} />}
                />
              </section>
            </div>
          ) : null}

          {tab === "deals" ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Deal</th>
                    <th className="px-5 py-3 text-left">Stage</th>
                    <th className="px-5 py-3 text-right">Days</th>
                    <th className="px-5 py-3 text-right">Value</th>
                    <th className="w-10 px-5 py-3" aria-hidden />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fixture.deals.map((d) => {
                    const overSla = d.days > d.sla;
                    return (
                      <tr
                        key={d.id}
                        onClick={() => navigate(`/deals/${d.id}`)}
                        className="cursor-pointer transition-colors hover:bg-slate-50"
                      >
                        <td className="px-5 py-4">
                          <p className="font-bold text-slate-950">{d.name}</p>
                        </td>
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                            {d.stage}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right tabular-nums">
                          <span className={`text-sm font-black ${overSla ? "text-brand-red" : "text-slate-950"}`}>
                            {d.days}d
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                          {USD(d.value)}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === "email" ? <EmailList emails={fixture.emails} /> : null}

          {tab === "recordings" ? <RecordingsList recordings={fixture.recordings} /> : null}

          {tab === "activity" ? (
            <div className="p-6">
              <ActivityTimeline items={fixture.activity} renderIcon={(k) => <ActivityIcon kind={k} />} />
            </div>
          ) : null}

          {tab === "files" ? <FilesView photos={fixture.photos} documents={fixture.documents} /> : null}

          {tab === "notes" ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm text-slate-500">No notes yet.</p>
              <Button variant="outline" size="sm" className="mt-3">
                <Plus className="mr-1 h-4 w-4" />
                Add note
              </Button>
            </div>
          ) : null}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div>
                <p className={EYEBROW}>Owner</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-red text-xs font-black uppercase text-white">
                    {fixture.ownerInitials}
                  </span>
                  <p className="text-sm font-semibold text-slate-950">{fixture.ownerName}</p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Company</p>
                <button
                  type="button"
                  onClick={() => navigate(`/companies/${fixture.companyId}`)}
                  className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-950 hover:text-brand-red"
                >
                  <Building2 className="h-4 w-4" />
                  {fixture.company}
                </button>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Role</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.role}</p>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>LinkedIn</p>
                <a
                  href={`https://${fixture.linkedin}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 flex items-center gap-1 text-sm font-semibold text-slate-700 hover:text-brand-red"
                >
                  {fixture.linkedin}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-5">
              <p className={EYEBROW}>System IDs</p>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-500">HubSpot</p>
                <p className="font-mono text-xs text-slate-700">
                  <Hash className="mr-0.5 inline h-3 w-3 -translate-y-px" />
                  {fixture.hubspotId}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
