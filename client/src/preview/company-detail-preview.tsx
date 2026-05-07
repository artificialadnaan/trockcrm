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
  MapPin,
  Building2,
  Handshake,
  ClipboardList,
  Activity,
  FileText,
  StickyNote,
  Globe,
  Hash,
  Headphones,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD, USD_COMPACT, MetricCard, ActivityTimeline, DetailTabs } from "./preview-shared";
import { EmailList, RecordingsList, type EmailRow, type RecordingRow } from "./comms-preview";
import { FilesView, type PhotoItem, type DocumentItem } from "./files-preview";

const fixture = {
  id: "1",
  name: "Dallas Independent SD",
  industry: "School District",
  region: "Dallas, TX",
  hubspotId: "hs_dallas_isd_2841",
  procoreId: "pc_dallas_isd_47",
  domain: "dallasisd.org",
  about:
    "Public school district serving Dallas County. Long-time T Rock client across 14 active properties. Procurement runs through facilities; decision making often shared between district facilities and individual school principals.",
  ownerInitials: "BR",
  ownerName: "Brett Rios",
  primaryContact: {
    name: "Marcus Holloway",
    title: "Director of Facilities",
    phone: "(214) 555-0102",
    email: "mholloway@dallasisd.org",
  },
  metrics: {
    activePipeline: 1_240_000,
    activeDealCount: 3,
    propertyCount: 14,
    contactCount: 8,
  },
  contacts: [
    { id: "1", name: "Marcus Holloway", title: "Director of Facilities", role: "Decision Maker", primary: true, lastTouch: "today" },
    { id: "11", name: "Ben Waters", title: "Sr. Project Manager", role: "Engineer", primary: false, lastTouch: "2 weeks ago" },
    { id: "13", name: "Karen Vu", title: "Procurement Specialist", role: "Procurement", primary: false, lastTouch: "1 week ago" },
    { id: "14", name: "Michael Adeyemi", title: "Asst. Director of Facilities", role: "Influencer", primary: false, lastTouch: "yesterday" },
  ],
  properties: [
    { id: "1", name: "Building A - Main Campus", address: "9400 N Central Expy", sqft: 142_000, status: "Active deal" },
    { id: "p2", name: "North Dallas High School", address: "1801 Yale Blvd", sqft: 188_000, status: "No engagement" },
    { id: "p3", name: "Hillcrest High School", address: "9924 Hillcrest Rd", sqft: 165_000, status: "No engagement" },
    { id: "p4", name: "Skyline High Auditorium", address: "7777 Forney Rd", sqft: 92_000, status: "Won project" },
  ],
  deals: [
    { id: "1", name: "Dallas ISD Roof Replacement", stage: "Estimating", days: 22, sla: 14, value: 875_000 },
    { id: "d12", name: "Dallas ISD Service Contract", stage: "Contract", days: 6, sla: 14, value: 240_000 },
    { id: "d13", name: "North Dallas HS Re-Roof Bid", stage: "Opportunity", days: 4, sla: 21, value: 125_000 },
  ],
  activity: [
    { id: "a1", icon: "phone", who: "Brett Rios", what: "Called Marcus re: SOV revision", when: "2h ago" },
    { id: "a2", icon: "mail", who: "Marcus Holloway", what: "Sent revised RFP attachments", when: "yesterday" },
    { id: "a3", icon: "calendar", who: "Brett Rios", what: "Site walk scheduled · Building A", when: "2 days ago" },
    { id: "a4", icon: "note", who: "Brett Rios", what: "Added internal note: bid pricing strategy", when: "3 days ago" },
    { id: "a5", icon: "deal", who: "System", what: "Dallas ISD Roof Replacement moved to Estimating", when: "5 days ago" },
  ],
  emails: [
    { id: "e1", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "RE: Building A roof phase 2 timeline", preview: "Confirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting...", date: "2h ago", unread: true, hasAttachment: true, attachmentCount: 2 },
    { id: "e2", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Updated SOV - Dallas ISD Bldg A", preview: "Marcus, attached the revised SOV with the drain replacement line items broken out. Let me know if the procurement office needs additional...", date: "yesterday", hasAttachment: true, attachmentCount: 1 },
    { id: "e3", fromName: "Karen Vu", fromEmail: "kvu@dallasisd.org", fromInitials: "KV", fromMe: false, subject: "PO question — Skyline auditorium", preview: "Hi Brett, the PO for the Skyline closeout came through with a different cost code than what we discussed. Can you...", date: "3 days ago" },
    { id: "e4", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Re: Bid pricing strategy", preview: "Looped in Takashi on this one. We're going to come in 6% under last year's benchmark with phased mobilization to keep their budget...", date: "5 days ago" },
    { id: "e5", fromName: "Michael Adeyemi", fromEmail: "madeyemi@dallasisd.org", fromInitials: "MA", fromMe: false, subject: "FW: Board agenda — facilities update", preview: "Forwarding the facilities discussion that's going up at the May 28 board meeting. Item 7c is your bid...", date: "1 week ago", hasAttachment: true, attachmentCount: 3 },
  ] satisfies EmailRow[],
  recordings: [
    { id: "r1", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 754, date: "2h ago", hasTranscript: true, transcript: "...so the bid timeline locks in mid-June. Your team can start submittals as soon as the board approves on the 28th...", topics: ["Bid timeline", "Phasing", "Submittals"] },
    { id: "r2", contactName: "Karen Vu", contactInitials: "KV", direction: "inbound", durationSeconds: 312, date: "3 days ago", hasTranscript: true, transcript: "Brett, Karen from procurement. Following up on the cost code question for the Skyline PO, we need to align with...", topics: ["PO codes", "Skyline closeout"] },
    { id: "r3", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 1840, date: "5 days ago", hasTranscript: true, transcript: "Walked through the bid pricing strategy. Marcus is comfortable with phased mobilization. Action items: revised SOV by Friday...", topics: ["Pricing", "Strategy", "Action items"] },
    { id: "r4", contactName: "Ben Waters", contactInitials: "BW", direction: "outbound", durationSeconds: 287, date: "1 week ago", hasTranscript: false, transcript: "" },
  ] satisfies RecordingRow[],
  photos: [
    { id: "p1", label: "Building A roof south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p2", label: "North Dallas HS aerial", takenBy: "BR", takenAt: "1 week ago" },
    { id: "p3", label: "Skyline auditorium", takenBy: "BR", takenAt: "3 weeks ago" },
    { id: "p4", label: "Hillcrest HVAC curbs", takenBy: "BR", takenAt: "1 month ago" },
  ] satisfies PhotoItem[],
  documents: [
    { id: "d1", name: "MSA — Dallas ISD 2024.pdf", kind: "Contract", sizeKB: 2_140, uploadedBy: "Marcus Holloway", uploadedAt: "1 month ago" },
    { id: "d2", name: "Building A — RFP packet.pdf", kind: "RFP", sizeKB: 4_320, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
    { id: "d3", name: "Dallas ISD Service Contract.pdf", kind: "Contract", sizeKB: 1_840, uploadedBy: "BR", uploadedAt: "2 weeks ago" },
    { id: "d4", name: "Skyline closeout proposal.pdf", kind: "Proposal", sizeKB: 980, uploadedBy: "BR", uploadedAt: "3 weeks ago" },
    { id: "d5", name: "Q2 board meeting agenda.pdf", kind: "Other", sizeKB: 220, uploadedBy: "Michael Adeyemi", uploadedAt: "1 week ago" },
  ] satisfies DocumentItem[],
};

type TabKey = "overview" | "contacts" | "properties" | "deals" | "email" | "recordings" | "activity" | "notes" | "files";

const TABS = [
  { key: "overview" as TabKey, label: "Overview", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "contacts" as TabKey, label: "Contacts", icon: <Star className="h-4 w-4" />, count: fixture.contacts.length },
  { key: "properties" as TabKey, label: "Properties", icon: <Building2 className="h-4 w-4" />, count: fixture.properties.length },
  { key: "deals" as TabKey, label: "Deals & Leads", icon: <Handshake className="h-4 w-4" />, count: fixture.deals.length },
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
    deal: Handshake,
  };
  const Icon = map[kind] ?? Activity;
  const tone =
    kind === "phone"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : kind === "mail"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : kind === "calendar"
          ? "bg-violet-50 text-violet-700 ring-violet-200"
          : kind === "note"
            ? "bg-amber-50 text-amber-700 ring-amber-200"
            : "bg-brand-red/10 text-brand-red ring-brand-red/20";
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function CompanyDetailPreview() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => navigate("/companies")}
          className="flex items-center gap-1 font-semibold text-slate-500 hover:text-brand-red"
        >
          <ArrowLeft className="h-3 w-3" />
          Companies
        </button>
        <ChevronRight className="h-3 w-3 text-slate-300" />
        <p className="font-bold text-slate-950">{fixture.name}</p>
      </div>

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-slate-900 text-2xl font-black uppercase text-white">
            {fixture.name
              .split(" ")
              .slice(0, 2)
              .map((w) => w[0])
              .join("")}
          </div>
          <div className="min-w-0">
            <p className={EYEBROW}>{fixture.industry}</p>
            <h1 className="mt-1 text-3xl font-black uppercase tracking-tight text-slate-950 md:text-4xl">
              {fixture.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {fixture.region}
              </span>
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <span className="inline-flex items-center gap-1">
                <Globe className="h-3.5 w-3.5" />
                {fixture.domain}
              </span>
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-400">
                <Hash className="h-3 w-3" />
                {fixture.hubspotId}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm">
            <Edit className="mr-1 h-4 w-4" />
            Edit
          </Button>
          <Button variant="outline" size="sm">
            <ExternalLink className="mr-1 h-4 w-4" />
            HubSpot
          </Button>
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" />
            New deal
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
          eyebrow="Active pipeline"
          value={USD_COMPACT(fixture.metrics.activePipeline)}
          badge={`${fixture.metrics.activeDealCount} deals`}
          badgeTone="green"
          caption="Open"
          accent="red"
        />
        <MetricCard
          eyebrow="Properties"
          value={String(fixture.metrics.propertyCount)}
          badge={`${fixture.properties.filter((p) => p.status === "Active deal").length} active`}
          badgeTone="blue"
          caption="In portfolio"
          accent="blue"
        />
        <MetricCard
          eyebrow="Contacts"
          value={String(fixture.metrics.contactCount)}
          badge={`${fixture.contacts.filter((c) => c.role === "Decision Maker" || c.primary).length} decision makers`}
          drenched
          caption="Across roles"
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

              <section>
                <div className="mb-3 flex items-center justify-between">
                  <p className={EYEBROW}>Primary contact</p>
                  <button
                    type="button"
                    onClick={() => setTab("contacts")}
                    className="text-xs font-bold uppercase tracking-wide text-brand-red hover:underline"
                  >
                    See all
                  </button>
                </div>
                <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50/40 p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black uppercase text-white">
                      {fixture.primaryContact.name
                        .split(" ")
                        .slice(0, 2)
                        .map((w) => w[0])
                        .join("")}
                    </span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="font-bold text-slate-950">{fixture.primaryContact.name}</p>
                        <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
                      </div>
                      <p className="text-xs text-slate-500">{fixture.primaryContact.title}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-white hover:text-slate-900"
                    >
                      <Phone className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-white hover:text-slate-900"
                    >
                      <Mail className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-white hover:text-slate-900"
                    >
                      <Calendar className="h-4 w-4" />
                    </button>
                  </div>
                </div>
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

          {tab === "contacts" ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Name</th>
                    <th className="px-5 py-3 text-left">Role</th>
                    <th className="px-5 py-3 text-left">Last touch</th>
                    <th className="px-5 py-3 text-left">Quick</th>
                    <th className="w-10 px-5 py-3" aria-hidden />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fixture.contacts.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/contacts/${c.id}`)}
                      className="cursor-pointer transition-colors hover:bg-slate-50"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                            {c.name
                              .split(" ")
                              .slice(0, 2)
                              .map((w) => w[0])
                              .join("")}
                          </span>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="font-bold text-slate-950">{c.name}</p>
                              {c.primary ? <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" /> : null}
                            </div>
                            <p className="text-xs text-slate-500">{c.title}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
                          {c.role}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-600">{c.lastTouch}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                          >
                            <Phone className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                          >
                            <Mail className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right">
                        <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === "properties" ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Property</th>
                    <th className="px-5 py-3 text-right">Sq ft</th>
                    <th className="px-5 py-3 text-left">Status</th>
                    <th className="w-10 px-5 py-3" aria-hidden />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fixture.properties.map((p) => {
                    const tone =
                      p.status === "Active deal"
                        ? "bg-brand-red/10 text-brand-red ring-brand-red/20"
                        : p.status === "Won project"
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : "bg-slate-100 text-slate-500 ring-slate-200";
                    return (
                      <tr
                        key={p.id}
                        onClick={() => navigate(`/properties/${p.id}`)}
                        className="cursor-pointer transition-colors hover:bg-slate-50"
                      >
                        <td className="px-5 py-4">
                          <p className="font-bold text-slate-950">{p.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{p.address}</p>
                        </td>
                        <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                          {p.sqft.toLocaleString()}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${tone}`}
                          >
                            {p.status}
                          </span>
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
                          <span className="ml-1 text-xs text-slate-400">/ {d.sla}d</span>
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
                <p className={EYEBROW}>Industry</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.industry}</p>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Region</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.region}</p>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Domain</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.domain}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-5">
              <p className={EYEBROW}>System IDs</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500">HubSpot</p>
                  <p className="font-mono text-xs text-slate-700">{fixture.hubspotId}</p>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500">Procore</p>
                  <p className="font-mono text-xs text-slate-700">{fixture.procoreId}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
