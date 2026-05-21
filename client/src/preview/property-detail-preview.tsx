import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Edit,
  ExternalLink,
  Plus,
  MoreHorizontal,
  MapPin,
  Camera,
  Building2,
  Handshake,
  Activity,
  FileText,
  StickyNote,
  ClipboardList,
  Hash,
  Layers,
  Mail,
  Headphones,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD, USD_COMPACT, MetricCard, ActivityTimeline, DetailTabs } from "./preview-shared";
import { EmailList, RecordingsList, type EmailRow, type RecordingRow } from "./comms-preview";
import { FilesView, type PhotoItem, type DocumentItem } from "./files-preview";

const fixture = {
  id: "1",
  name: "Building A - Main Campus",
  address: "9400 N Central Expy",
  city: "Dallas, TX",
  zip: "75231",
  type: "School",
  ownerCompany: "Dallas Independent SD",
  ownerCompanyId: "1",
  sqft: 142_000,
  floors: 3,
  yearBuilt: 1968,
  roofArea: 138_000,
  procoreId: "pc_property_dallas_1",
  companyCamId: "ccam_8821",
  about:
    "Three-story administration building. Existing TPO membrane installed 2009, now in 16th year. Roof drains audited last summer; six need replacement under any re-cover. Building stays occupied throughout work — phasing required.",
  metrics: {
    sqft: 142_000,
    activePipelineValue: 875_000,
    photoCount: 47,
  },
  status: "Active deal",
  activeDeal: {
    id: "1",
    name: "Dallas ISD Roof Replacement",
    stage: "Estimating",
    days: 22,
    sla: 14,
    value: 875_000,
  },
  history: [
    { id: "h1", year: 2021, type: "Service", value: 18_500, summary: "Drain replacement (4 units)" },
    { id: "h2", year: 2017, type: "Repair", value: 8_200, summary: "TPO patch repair, roof penetrations" },
    { id: "h3", year: 2009, type: "Re-roof", value: 412_000, summary: "Full TPO membrane install (incumbent)" },
  ],
  photos: [
    { id: "p1", label: "Ridge cap south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p2", label: "Drain bay 4", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p3", label: "HVAC curb 7", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p4", label: "Parapet east", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p5", label: "Skylight cluster", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p6", label: "Stair access", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p7", label: "TPO seam south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p8", label: "Roof penetration west", takenBy: "BR", takenAt: "2 days ago" },
  ] satisfies PhotoItem[],
  documents: [
    { id: "d1", name: "Building A — RFP packet.pdf", kind: "RFP", sizeKB: 4_320, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
    { id: "d2", name: "Roof drain audit summary.pdf", kind: "Spec", sizeKB: 820, uploadedBy: "BR", uploadedAt: "yesterday" },
    { id: "d3", name: "TPO replacement options.pdf", kind: "Estimate", sizeKB: 1_240, uploadedBy: "BR", uploadedAt: "1 week ago" },
    { id: "d4", name: "Building A floor plan.dwg", kind: "Drawing", sizeKB: 8_440, uploadedBy: "Marcus Holloway", uploadedAt: "2 weeks ago" },
  ] satisfies DocumentItem[],
  activity: [
    { id: "a1", icon: "calendar", who: "Brett Rios", what: "Site walk completed · 90 min on roof", when: "2 days ago" },
    { id: "a2", icon: "camera", who: "Brett Rios", what: "Uploaded 47 photos via CompanyCam", when: "2 days ago" },
    { id: "a3", icon: "deal", who: "System", what: "Linked to deal: Dallas ISD Roof Replacement", when: "5 days ago" },
    { id: "a4", icon: "note", who: "Brett Rios", what: "Note: phasing constraint, summer break only", when: "1 week ago" },
  ],
  emails: [
    { id: "e1", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "RE: Building A roof phase 2 timeline", preview: "Confirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting...", date: "2h ago", unread: true, hasAttachment: true, attachmentCount: 2 },
    { id: "e2", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Building A — roof drain audit summary", preview: "Marcus, attached the photo audit from yesterday's walk. Six drains need replacement under any re-cover scope. Drain bay 4...", date: "yesterday", hasAttachment: true, attachmentCount: 3 },
    { id: "e3", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "Site walk Friday morning", preview: "Brett, Friday at 8:30am works on my end. I'll meet you at the north entrance. Let's plan 90 minutes — I want to walk the parapet and...", date: "3 days ago" },
    { id: "e4", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Building A — TPO replacement options", preview: "Three membrane options for the re-cover. TPO 60-mil mechanically fastened comes in cleanest on lifecycle cost. Adhered system bumps...", date: "1 week ago", hasAttachment: true, attachmentCount: 1 },
  ] satisfies EmailRow[],
  recordings: [
    { id: "r1", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 542, date: "yesterday", hasTranscript: true, transcript: "Walked Marcus through the drain audit findings. Six drains in bay 4 need replacement, plus the parapet flashing has UV damage on the south...", topics: ["Drain audit", "Parapet", "Phasing"] },
    { id: "r2", contactName: "Marcus Holloway", contactInitials: "MH", direction: "inbound", durationSeconds: 412, date: "3 days ago", hasTranscript: true, transcript: "Brett, Marcus. Got time to talk through the parapet question on Building A? I want to make sure the SOV reflects what we walked...", topics: ["Site walk", "SOV"] },
    { id: "r3", contactName: "Ben Waters", contactInitials: "BW", direction: "outbound", durationSeconds: 287, date: "1 week ago", hasTranscript: false, transcript: "" },
  ] satisfies RecordingRow[],
};

type TabKey = "overview" | "deal" | "history" | "email" | "recordings" | "activity" | "files";

const TABS = [
  { key: "overview" as TabKey, label: "Overview", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "deal" as TabKey, label: "Active deal", icon: <Handshake className="h-4 w-4" /> },
  { key: "history" as TabKey, label: "History", icon: <Layers className="h-4 w-4" />, count: fixture.history.length },
  { key: "email" as TabKey, label: "Email", icon: <Mail className="h-4 w-4" />, count: fixture.emails.length },
  { key: "recordings" as TabKey, label: "Recordings", icon: <Headphones className="h-4 w-4" />, count: fixture.recordings.length },
  { key: "activity" as TabKey, label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "files" as TabKey, label: "Files", icon: <FileText className="h-4 w-4" />, count: fixture.photos.length + fixture.documents.length },
];

function ActivityIcon({ kind }: { kind: string }) {
  const tone =
    kind === "calendar"
      ? "bg-violet-50 text-violet-700 ring-violet-200"
      : kind === "camera"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : kind === "deal"
          ? "bg-brand-red/10 text-brand-red ring-brand-red/20"
          : "bg-amber-50 text-amber-700 ring-amber-200";
  const Icon =
    kind === "calendar" ? MapPin : kind === "camera" ? Camera : kind === "deal" ? Handshake : StickyNote;
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function PropertyDetailPreview() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => navigate("/properties")}
          className="flex items-center gap-1 font-semibold text-slate-500 hover:text-brand-red"
        >
          <ArrowLeft className="h-3 w-3" />
          Properties
        </button>
        <ChevronRight className="h-3 w-3 text-slate-300" />
        <p className="font-bold text-slate-950">{fixture.name}</p>
      </div>

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white">
            <Building2 className="h-9 w-9" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className={EYEBROW}>{fixture.type}</p>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-red" aria-hidden />
                {fixture.status}
              </span>
            </div>
            <h1 className="mt-1 text-3xl font-black uppercase tracking-tight text-slate-950 md:text-4xl">
              {fixture.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {fixture.address} · {fixture.city} {fixture.zip}
              </span>
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <button
                type="button"
                onClick={() => navigate(`/companies/${fixture.ownerCompanyId}`)}
                className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red"
              >
                <Building2 className="h-3.5 w-3.5" />
                {fixture.ownerCompany}
              </button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm">
            <Edit className="mr-1 h-4 w-4" />
            Edit
          </Button>
          <Button variant="outline" size="sm">
            <Camera className="mr-1 h-4 w-4" />
            CompanyCam
          </Button>
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" />
            New lead
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
          eyebrow="Roof area"
          value={`${(fixture.roofArea / 1000).toFixed(0)}K`}
          badge={`${fixture.metrics.sqft.toLocaleString()} sq ft total`}
          badgeTone="green"
          caption="Sq ft"
          accent="red"
        />
        <MetricCard
          eyebrow="Photos on file"
          value={String(fixture.metrics.photoCount)}
          badge="last 2 days"
          badgeTone="blue"
          caption="Via CompanyCam"
          accent="blue"
        />
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(fixture.metrics.activePipelineValue)}
          badge="1 deal"
          drenched
          caption="In Estimating"
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
                <p className={EYEBROW}>Building specs</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Total sq ft</p>
                    <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">
                      {fixture.metrics.sqft.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Floors</p>
                    <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{fixture.floors}</p>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Year built</p>
                    <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{fixture.yearBuilt}</p>
                  </div>
                </div>
              </section>

              <section>
                <p className={EYEBROW}>Location</p>
                <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
                  <svg viewBox="0 0 400 180" className="h-40 w-full bg-gradient-to-br from-slate-50 to-slate-100">
                    <defs>
                      <pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
                      </pattern>
                    </defs>
                    <rect width="400" height="180" fill="url(#map-grid)" />
                    <circle cx="200" cy="90" r="40" fill="white" stroke="#cbd5e1" strokeWidth="1" />
                    <circle cx="200" cy="90" r="6" fill="#CC0000" stroke="white" strokeWidth="2" />
                    <text x="200" y="120" textAnchor="middle" fontSize="11" fontWeight="700" fill="#0f172a">
                      {fixture.address}
                    </text>
                    <text x="200" y="135" textAnchor="middle" fontSize="10" fill="#64748b">
                      {fixture.city}
                    </text>
                  </svg>
                </div>
              </section>
            </div>
          ) : null}

          {tab === "deal" ? (
            <div className="p-6">
              <div
                onClick={() => navigate(`/deals/${fixture.activeDeal.id}`)}
                className="cursor-pointer rounded-md border border-slate-200 p-4 transition-colors hover:bg-slate-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-950">{fixture.activeDeal.name}</p>
                    <span className="mt-2 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                      {fixture.activeDeal.stage}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-black tabular-nums text-slate-950">
                      {USD(fixture.activeDeal.value)}
                    </p>
                    <p
                      className={`mt-0.5 text-xs font-bold tabular-nums ${
                        fixture.activeDeal.days > fixture.activeDeal.sla ? "text-brand-red" : "text-slate-500"
                      }`}
                    >
                      {fixture.activeDeal.days}d / SLA {fixture.activeDeal.sla}d
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "history" ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Year</th>
                    <th className="px-5 py-3 text-left">Type</th>
                    <th className="px-5 py-3 text-left">Summary</th>
                    <th className="px-5 py-3 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fixture.history.map((h) => (
                    <tr key={h.id} className="transition-colors hover:bg-slate-50">
                      <td className="px-5 py-4 text-sm font-black tabular-nums text-slate-950">{h.year}</td>
                      <td className="px-5 py-4">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
                          {h.type}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700">{h.summary}</td>
                      <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                        {USD(h.value)}
                      </td>
                    </tr>
                  ))}
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
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div>
                <p className={EYEBROW}>Owner company</p>
                <button
                  type="button"
                  onClick={() => navigate(`/companies/${fixture.ownerCompanyId}`)}
                  className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-950 hover:text-brand-red"
                >
                  <Building2 className="h-4 w-4" />
                  {fixture.ownerCompany}
                </button>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Address</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.address}</p>
                <p className="text-sm text-slate-600">
                  {fixture.city} {fixture.zip}
                </p>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Type</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{fixture.type}</p>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Year built</p>
                <p className="mt-1 text-sm font-semibold text-slate-950 tabular-nums">{fixture.yearBuilt}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-5">
              <p className={EYEBROW}>System IDs</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500">Procore</p>
                  <p className="font-mono text-xs text-slate-700">
                    <Hash className="mr-0.5 inline h-3 w-3 -translate-y-px" />
                    {fixture.procoreId}
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500">CompanyCam</p>
                  <p className="font-mono text-xs text-slate-700">
                    <Hash className="mr-0.5 inline h-3 w-3 -translate-y-px" />
                    {fixture.companyCamId}
                  </p>
                </div>
              </div>
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="inline-flex items-center gap-1 text-xs font-bold text-brand-red hover:underline"
              >
                Open in Procore
                <ExternalLink className="h-3 w-3" />
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
