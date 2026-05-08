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
  Briefcase,
  ClipboardList,
  Activity,
  FileText,
  StickyNote,
  Camera,
  Layers,
  Hash,
  DollarSign,
  Headphones,
  CheckCircle2,
  Circle,
  Lock,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD, MetricCard, ActivityTimeline, DetailTabs } from "./preview-shared";
import { EmailList, RecordingsList, type EmailRow, type RecordingRow } from "./comms-preview";
import { FilesView, type PhotoItem, type DocumentItem } from "./files-preview";

type PipelineSlot = {
  primary: string;
  alt?: string;
  isTerminal?: boolean;
};

const PIPELINE_SLOTS: PipelineSlot[] = [
  { primary: "Opportunity" },
  { primary: "Estimating", alt: "Service Estimating" },
  { primary: "Under Review" },
  { primary: "Estimate Sent" },
  { primary: "Contract" },
  { primary: "Won", alt: "Lost", isTerminal: true },
];

const fixture = {
  id: "1",
  name: "Dallas ISD Roof Replacement",
  stage: "Estimating",
  stageIndex: 1,
  account: { id: "1", name: "Dallas Independent SD" },
  property: { id: "1", name: "Building A - Main Campus", address: "9400 N Central Expy, Dallas, TX" },
  primaryContact: { id: "1", name: "Marcus Holloway", title: "Director of Facilities" },
  ownerInitials: "BR",
  ownerName: "Brett Rios",
  daysInStage: 22,
  sla: 14,
  totalValue: 875_000,
  estimatedMargin: 0.21,
  procoreId: "pc_deal_dallas_isd_001",
  hubspotId: "hs_deal_82211",
  closeDate: "Jun 15, 2026",
  bidBoardOwned: true,
  bidBoardSummary: {
    stage: "Estimating · Pricing review",
    estimate: "Pending — due May 28",
    lastSynced: "2 hours ago",
    assignedPM: "Sarah Chen",
    bidBoardUrl: "https://app.procore.com/...",
  },
  about:
    "Full TPO membrane re-cover on Building A — Main Campus. Existing 60-mil mechanically fastened, installed 2009. Six drains require replacement under any scope. Phasing constraint: occupied building, work limited to summer break (Jun 15 – Aug 3).",
  stageHistory: [
    { id: "h1", stage: "Estimating", who: "Brett Rios", when: "5 days ago", duration: "5d so far", note: "Auto-moved from Bid Board sync" },
    { id: "h2", stage: "Opportunity", who: "Brett Rios", when: "2 weeks ago", duration: "9d", note: "Converted from Sales Validation lead" },
    { id: "h3", stage: "Sales Validation", who: "Brett Rios", when: "3 weeks ago", duration: "7d", note: "Lead promoted from qualified" },
  ],
  estimateLines: [
    { id: "l1", label: "TPO membrane (60 mil mechanically fastened)", qty: 138_000, unit: "sf", rate: 4.8, total: 662_400 },
    { id: "l2", label: "Roof drain replacement (six units)", qty: 6, unit: "ea", rate: 1_850, total: 11_100 },
    { id: "l3", label: "Insulation R-30 polyiso", qty: 138_000, unit: "sf", rate: 1.05, total: 144_900 },
    { id: "l4", label: "Demolition + disposal", qty: 1, unit: "lot", rate: 28_500, total: 28_500 },
    { id: "l5", label: "Mobilization + safety", qty: 1, unit: "lot", rate: 28_100, total: 28_100 },
  ],
  emails: [
    { id: "e1", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "RE: Building A roof phase 2 timeline", preview: "Confirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting...", date: "2h ago", unread: true, hasAttachment: true, attachmentCount: 2 },
    { id: "e2", fromName: "Brett Rios", fromEmail: "brett@trockconstruction.com", fromInitials: "BR", fromMe: true, subject: "Updated SOV - Dallas ISD Bldg A", preview: "Marcus, attached the revised SOV with the drain replacement line items broken out. Let me know if the procurement office needs additional...", date: "yesterday", hasAttachment: true, attachmentCount: 1 },
    { id: "e3", fromName: "Marcus Holloway", fromEmail: "mholloway@dallasisd.org", fromInitials: "MH", fromMe: false, subject: "Site walk Friday morning", preview: "Brett, Friday at 8:30am works on my end. I'll meet you at the north entrance. Let's plan 90 minutes — I want to walk the parapet and...", date: "3 days ago" },
  ] satisfies EmailRow[],
  recordings: [
    { id: "r1", contactName: "Marcus Holloway", contactInitials: "MH", direction: "outbound", durationSeconds: 754, date: "2h ago", hasTranscript: true, transcript: "...so the bid timeline locks in mid-June. Your team can start submittals as soon as the board approves on the 28th...", topics: ["Bid timeline", "Phasing", "Submittals"] },
    { id: "r2", contactName: "Marcus Holloway", contactInitials: "MH", direction: "inbound", durationSeconds: 412, date: "3 days ago", hasTranscript: true, transcript: "Brett, Marcus. Got time to talk through the parapet question on Building A? I want to make sure the SOV reflects what we walked...", topics: ["Site walk", "SOV"] },
  ] satisfies RecordingRow[],
  photos: [
    { id: "p1", label: "Ridge cap south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p2", label: "Drain bay 4", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p3", label: "HVAC curb 7", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p4", label: "Parapet east", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p5", label: "Skylight cluster", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p6", label: "Stair access", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p7", label: "TPO seam south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p8", label: "Roof penetration west", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p9", label: "Drain bay 1", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p10", label: "Membrane wear south", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p11", label: "Coping cap detail", takenBy: "BR", takenAt: "2 days ago" },
    { id: "p12", label: "Mechanical platform", takenBy: "BR", takenAt: "2 days ago" },
  ] satisfies PhotoItem[],
  documents: [
    { id: "d1", name: "Dallas ISD Bldg A — Estimate v2.pdf", kind: "Estimate", sizeKB: 1_240, uploadedBy: "BR", uploadedAt: "yesterday" },
    { id: "d2", name: "Building A — RFP packet.pdf", kind: "RFP", sizeKB: 4_320, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
    { id: "d3", name: "Pre-bid Q&A draft.pdf", kind: "Spec", sizeKB: 240, uploadedBy: "Marcus Holloway", uploadedAt: "1 week ago" },
    { id: "d4", name: "TPO membrane spec sheet.pdf", kind: "Spec", sizeKB: 540, uploadedBy: "BR", uploadedAt: "2 weeks ago" },
    { id: "d5", name: "Building A floor plan.dwg", kind: "Drawing", sizeKB: 8_440, uploadedBy: "Marcus Holloway", uploadedAt: "2 weeks ago" },
  ] satisfies DocumentItem[],
  activity: [
    { id: "a1", icon: "phone", who: "Brett Rios", what: "Called Marcus re: SOV revision · 12 min", when: "2h ago" },
    { id: "a2", icon: "mail", who: "Marcus Holloway", what: "Sent revised RFP attachments", when: "yesterday" },
    { id: "a3", icon: "camera", who: "Brett Rios", what: "Uploaded 12 site walk photos", when: "2 days ago" },
    { id: "a4", icon: "calendar", who: "Brett Rios", what: "Site walk completed · 90 min on roof", when: "2 days ago" },
    { id: "a5", icon: "stage", who: "System", what: "Stage moved: Opportunity → Estimating", when: "5 days ago" },
  ],
};

type TabKey = "overview" | "stage" | "estimate" | "email" | "recordings" | "photos" | "activity" | "files";

const TABS = [
  { key: "overview" as TabKey, label: "Overview", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "stage" as TabKey, label: "Stage history", icon: <Layers className="h-4 w-4" />, count: fixture.stageHistory.length },
  { key: "estimate" as TabKey, label: "Estimate", icon: <DollarSign className="h-4 w-4" />, count: fixture.estimateLines.length },
  { key: "email" as TabKey, label: "Email", icon: <Mail className="h-4 w-4" />, count: fixture.emails.length },
  { key: "recordings" as TabKey, label: "Recordings", icon: <Headphones className="h-4 w-4" />, count: fixture.recordings.length },
  { key: "photos" as TabKey, label: "Photos", icon: <Camera className="h-4 w-4" />, count: fixture.photos.length },
  { key: "activity" as TabKey, label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "files" as TabKey, label: "Files", icon: <FileText className="h-4 w-4" />, count: fixture.documents.length },
];

function ActivityIcon({ kind }: { kind: string }) {
  const tone =
    kind === "phone"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : kind === "mail"
        ? "bg-blue-50 text-blue-700 ring-blue-200"
        : kind === "calendar"
          ? "bg-violet-50 text-violet-700 ring-violet-200"
          : kind === "camera"
            ? "bg-blue-50 text-blue-700 ring-blue-200"
            : kind === "stage"
              ? "bg-brand-red/10 text-brand-red ring-brand-red/20"
              : "bg-amber-50 text-amber-700 ring-amber-200";
  const Icon =
    kind === "phone"
      ? Phone
      : kind === "mail"
        ? Mail
        : kind === "calendar"
          ? Calendar
          : kind === "camera"
            ? Camera
            : kind === "stage"
              ? Briefcase
              : StickyNote;
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function DealDetailPreview() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");
  const overSla = fixture.daysInStage > fixture.sla;
  const estimateTotal = fixture.estimateLines.reduce((s, l) => s + l.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => navigate("/deals")}
          className="flex items-center gap-1 font-semibold text-slate-500 hover:text-brand-red"
        >
          <ArrowLeft className="h-3 w-3" />
          Deals
        </button>
        <ChevronRight className="h-3 w-3 text-slate-300" />
        <p className="font-bold text-slate-950">{fixture.name}</p>
      </div>

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white">
            <Briefcase className="h-9 w-9" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
                {fixture.stage}
              </span>
              <span className={`text-[11px] font-bold uppercase tracking-wide ${overSla ? "text-brand-red" : "text-slate-500"}`}>
                {fixture.daysInStage}d in stage · SLA {fixture.sla}d
              </span>
            </div>
            <h1 className="mt-1 text-3xl font-black uppercase tracking-tight text-slate-950 md:text-4xl">
              {fixture.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <button
                type="button"
                onClick={() => navigate(`/companies/${fixture.account.id}`)}
                className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red"
              >
                <Building2 className="h-3.5 w-3.5" />
                {fixture.account.name}
              </button>
              <span className="text-slate-300" aria-hidden>·</span>
              <button
                type="button"
                onClick={() => navigate(`/properties/${fixture.property.id}`)}
                className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red"
              >
                <MapPin className="h-3.5 w-3.5" />
                {fixture.property.name}
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
            <ExternalLink className="mr-1 h-4 w-4" />
            Procore
          </Button>
          <Button size="sm">
            Move stage
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </section>

      {fixture.bidBoardOwned ? (
        <Card className="overflow-hidden border-amber-200 bg-amber-50/40">
          <div className="flex items-start gap-4 p-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200">
              <Lock className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-sm font-black text-amber-900">Bid Board now owns downstream progression</p>
                <p className="mt-0.5 text-xs text-amber-800">
                  Bid Board is the source of truth once this deal entered Estimating.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold text-amber-800">
                  Synced from Bid Board {fixture.bidBoardSummary.lastSynced}
                </p>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-800 hover:bg-amber-100"
                >
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </button>
              </div>
              <div className="grid gap-3 border-t border-amber-200 pt-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">Still editable in CRM</p>
                  <p className="mt-1 text-xs font-semibold text-amber-900">
                    deal details, files, activity, notes
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">Mirrored from Bid Board</p>
                  <p className="mt-1 text-xs font-semibold text-amber-900">
                    stage progression, proposal status, estimating progress, estimate amounts, downstream mirror metadata
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Deal value"
          value={USD(fixture.totalValue)}
          badge={`${(fixture.estimatedMargin * 100).toFixed(0)}% margin`}
          badgeTone="green"
          caption="Estimated"
          accent="red"
        />
        <MetricCard
          eyebrow="Stage age"
          value={`${fixture.daysInStage}d`}
          badge={overSla ? "over SLA" : "within SLA"}
          badgeTone={overSla ? "white" : "blue"}
          caption={`SLA ${fixture.sla}d`}
          accent="blue"
        />
        <MetricCard
          eyebrow="Close target"
          value={fixture.closeDate}
          badge={`stage ${fixture.stageIndex + 1} of ${PIPELINE_SLOTS.length}`}
          drenched
          caption="Estimating phase"
        />
      </div>

      <Card>
        <CardContent className="p-5">
          <p className={EYEBROW}>Pipeline progress</p>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
            {PIPELINE_SLOTS.map((slot, i) => {
              const isComplete = i < fixture.stageIndex;
              const isCurrent = i === fixture.stageIndex;
              const barClass = isComplete
                ? "bg-emerald-400"
                : isCurrent
                  ? "bg-brand-red"
                  : "bg-slate-200";
              const primaryTone = isCurrent
                ? "text-brand-red"
                : isComplete
                  ? "text-slate-700"
                  : "text-slate-400";
              return (
                <div key={slot.primary} className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className={`shrink-0 ${primaryTone}`}>
                      {isComplete ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : isCurrent ? (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-red text-[9px] font-black text-white">
                          {i + 1}
                        </span>
                      ) : (
                        <Circle className="h-4 w-4" />
                      )}
                    </span>
                    <p className={`text-[10px] font-bold uppercase tracking-wide leading-tight ${primaryTone}`}>
                      {slot.primary}
                    </p>
                  </div>
                  <div className={`mt-3 h-1 w-full rounded-full ${barClass}`} />
                  {slot.alt ? (
                    <div className="mt-3 flex items-center gap-1.5">
                      <span className="shrink-0 text-slate-400">
                        <Circle className="h-4 w-4" />
                      </span>
                      <p className="text-[10px] font-bold uppercase tracking-wide leading-tight text-slate-400">
                        {slot.alt}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {fixture.bidBoardOwned ? (
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black text-slate-950">Bid Board summary</p>
                <p className="mt-0.5 text-xs text-slate-500">Read-only project status mirrored from Bid Board.</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
                <Lock className="h-3 w-3" />
                Managed by Bid Board
              </span>
            </div>
            <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className={EYEBROW}>Stage</p>
                <p className="mt-1 text-sm font-bold text-slate-950">{fixture.bidBoardSummary.stage}</p>
              </div>
              <div>
                <p className={EYEBROW}>Estimate</p>
                <p className="mt-1 text-sm font-bold text-slate-950">{fixture.bidBoardSummary.estimate}</p>
              </div>
              <div>
                <p className={EYEBROW}>Last synced</p>
                <p className="mt-1 text-sm font-bold text-slate-950">{fixture.bidBoardSummary.lastSynced}</p>
              </div>
              <div>
                <p className={EYEBROW}>Assigned PM</p>
                <p className="mt-1 text-sm font-bold text-slate-950">{fixture.bidBoardSummary.assignedPM}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button size="sm">
                Open in Bid Board
                <ExternalLink className="ml-1 h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm">
                <RefreshCw className="mr-1 h-4 w-4" />
                Resync
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <Card>
          <DetailTabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === "overview" ? (
            <div className="space-y-6 p-6">
              <section>
                <p className={EYEBROW}>Scope</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{fixture.about}</p>
              </section>

              <section>
                <p className={EYEBROW}>Key parties</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => navigate(`/contacts/${fixture.primaryContact.id}`)}
                    className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50/40 p-4 text-left transition-colors hover:bg-slate-100"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black uppercase text-white">
                      MH
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-bold text-slate-950">{fixture.primaryContact.name}</p>
                        <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
                      </div>
                      <p className="truncate text-xs text-slate-500">{fixture.primaryContact.title}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50/40 p-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-black uppercase text-white">
                      {fixture.ownerInitials}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Owner</p>
                      <p className="truncate text-sm font-bold text-slate-950">{fixture.ownerName}</p>
                    </div>
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

          {tab === "stage" ? (
            <div className="p-6">
              <ol className="relative space-y-5 border-l border-slate-200 pl-5">
                {fixture.stageHistory.map((h, i) => (
                  <li key={h.id} className="relative">
                    <span className="absolute -left-[26px] top-0 flex h-6 w-6 items-center justify-center rounded-full bg-white ring-2 ring-slate-200">
                      <span className={`h-2 w-2 rounded-full ${i === 0 ? "bg-brand-red" : "bg-slate-300"}`} />
                    </span>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-slate-950">{h.stage}</p>
                      <span className="text-xs font-semibold tabular-nums text-slate-500">{h.duration}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      <span className="font-semibold">{h.who}</span> · {h.when}
                    </p>
                    <p className="mt-1 text-xs italic text-slate-600">{h.note}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {tab === "estimate" ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-5 py-3 text-left">Line</th>
                    <th className="px-5 py-3 text-right">Qty</th>
                    <th className="px-5 py-3 text-right">Rate</th>
                    <th className="px-5 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fixture.estimateLines.map((l) => (
                    <tr key={l.id} className="transition-colors hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <p className="text-sm font-semibold text-slate-950">{l.label}</p>
                      </td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums text-slate-700">
                        {l.qty.toLocaleString()} <span className="text-xs text-slate-400">{l.unit}</span>
                      </td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums text-slate-700">
                        {USD(l.rate)}
                      </td>
                      <td className="px-5 py-3 text-right text-sm font-black tabular-nums text-slate-950">
                        {USD(l.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50/40">
                    <td colSpan={3} className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">
                      Estimate total
                    </td>
                    <td className="px-5 py-3 text-right text-base font-black tabular-nums text-slate-950">
                      {USD(estimateTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}

          {tab === "email" ? <EmailList emails={fixture.emails} /> : null}

          {tab === "recordings" ? <RecordingsList recordings={fixture.recordings} /> : null}

          {tab === "photos" ? (
            <div className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <p className={EYEBROW}>{fixture.photos.length} photos · CompanyCam</p>
                <Button size="sm">
                  <Plus className="mr-1 h-4 w-4" />
                  Upload
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {fixture.photos.map((p) => (
                  <div key={p.id} className="group overflow-hidden rounded-md border border-slate-200">
                    <div className="aspect-[4/3] bg-gradient-to-br from-slate-200 to-slate-300">
                      <div className="flex h-full w-full items-center justify-center">
                        <Camera className="h-8 w-8 text-white/70" />
                      </div>
                    </div>
                    <div className="border-t border-slate-100 bg-white px-3 py-2">
                      <p className="truncate text-xs font-bold text-slate-950">{p.label}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {p.takenBy} · {p.takenAt}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "activity" ? (
            <div className="p-6">
              <ActivityTimeline items={fixture.activity} renderIcon={(k) => <ActivityIcon kind={k} />} />
            </div>
          ) : null}

          {tab === "files" ? <FilesView photos={[]} documents={fixture.documents} /> : null}
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
                <p className={EYEBROW}>Account</p>
                <button
                  type="button"
                  onClick={() => navigate(`/companies/${fixture.account.id}`)}
                  className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-950 hover:text-brand-red"
                >
                  <Building2 className="h-4 w-4" />
                  {fixture.account.name}
                </button>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Property</p>
                <button
                  type="button"
                  onClick={() => navigate(`/properties/${fixture.property.id}`)}
                  className="mt-2 flex items-start gap-2 text-left text-sm font-semibold text-slate-950 hover:text-brand-red"
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {fixture.property.name}
                    <span className="block text-xs font-normal text-slate-500">{fixture.property.address}</span>
                  </span>
                </button>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className={EYEBROW}>Primary contact</p>
                <button
                  type="button"
                  onClick={() => navigate(`/contacts/${fixture.primaryContact.id}`)}
                  className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-950 hover:text-brand-red"
                >
                  <Star className="h-4 w-4 fill-amber-400 stroke-amber-400" />
                  {fixture.primaryContact.name}
                </button>
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
                  <p className="text-xs font-semibold text-slate-500">HubSpot</p>
                  <p className="font-mono text-xs text-slate-700">
                    <Hash className="mr-0.5 inline h-3 w-3 -translate-y-px" />
                    {fixture.hubspotId}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
