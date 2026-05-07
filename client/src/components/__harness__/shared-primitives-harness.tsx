import { useState, type ReactNode } from "react";
import {
  Activity,
  Archive,
  Briefcase,
  Building2,
  Calendar,
  Camera,
  FileText,
  FolderOpen,
  Handshake,
  Home,
  Mail,
  Mic,
  NotebookPen,
  Phone,
  User,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityTimeline } from "@/components/shared/activity-timeline";
import { DetailTabs } from "@/components/shared/detail-tabs";
import { Eyebrow } from "@/components/shared/eyebrow";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { EmailList } from "@/components/comms/email-list";
import { RecordingsList } from "@/components/comms/recordings-list";
import { FilesView } from "@/components/files/files-view";

const repDashboardMock = {
  activeDeals: { count: 18, totalValue: 4860000 },
  activeLeads: { count: 42 },
  contractsSignedYtd: { count: 31, totalValue: 12400000 },
  contractsSignedMtd: { count: 5, totalValue: 1820000 },
  tasksToday: { overdue: 3, today: 11 },
  activityThisWeek: { calls: 26, emails: 41, meetings: 8, notes: 19, total: 94 },
  followUpCompliance: { total: 48, onTime: 41, complianceRate: 85 },
  commissionSummary: { earnedYtd: 186000, projected: 242000 },
  funnelBuckets: [
    { label: "Leads", count: 42 },
    { label: "Qualified", count: 17 },
    { label: "Opportunities", count: 18 },
    { label: "Bid Board", count: 9 },
  ],
  leadSnapshot: [{ id: "lead-1", name: "Keller ISD reroof", estimatedValue: 650000 }],
  dealSnapshot: [{ id: "deal-1", name: "DFW Logistics Center", value: 1200000 }],
};

const activityItems = [
  { id: "a1", type: "phone" as const, who: "Brett", what: "Called facilities director", when: "Today 8:10 AM" },
  { id: "a2", type: "mail" as const, who: "Microsoft 365", what: "Proposal follow-up email linked", when: "Today 9:35 AM" },
  { id: "a3", type: "calendar" as const, who: "Sarah", what: "Site walk scheduled", when: "Tomorrow 2:00 PM" },
  { id: "a4", type: "note" as const, who: "Adnaan", what: "Added scope note", when: "Yesterday" },
  { id: "a5", type: "deal" as const, who: "System", what: "Moved deal to Estimating", when: "2 days ago" },
];

const emailRows = [
  {
    id: "em-1",
    fromName: "Mary Caldwell",
    fromEmail: "mary@kellerisd.edu",
    fromInitials: "MC",
    fromMe: false,
    subject: "Reroof package and access notes",
    preview: "Attached the latest roof access notes for the bid package.",
    date: "9:14 AM",
    status: "linked" as const,
    linkedRecords: [{ id: "deal-1", type: "deal" as const, label: "Keller ISD Reroof" }],
    unread: true,
    hasAttachment: true,
    attachmentCount: 2,
  },
  {
    id: "em-2",
    fromName: "Unknown sender",
    fromEmail: "projects@vendor.example",
    fromInitials: "UV",
    fromMe: false,
    subject: "Bid invite follow-up",
    preview: "Can you confirm the correct project owner?",
    date: "Yesterday",
    status: "unassigned" as const,
  },
  {
    id: "em-3",
    fromName: "Brett Jones",
    fromEmail: "brett@trockconstruction.com",
    fromInitials: "BJ",
    fromMe: true,
    subject: "Sent site visit recap",
    preview: "Thanks for walking the building with us this morning.",
    date: "Mon",
    status: "sent" as const,
    linkedRecords: [{ id: "contact-1", type: "contact" as const, label: "Luis Ramirez" }],
  },
];

const recordings = [
  {
    id: "rec-101",
    contactName: "Mary Caldwell",
    contactInitials: "MC",
    direction: "inbound" as const,
    durationSeconds: 312,
    date: "Today",
    hasTranscript: true,
    transcript: "They need phasing options before Friday and want photos attached to the file packet.",
    topics: ["phasing", "photos", "deadline"],
  },
  {
    id: "rec-102",
    contactName: "Luis Ramirez",
    contactInitials: "LR",
    direction: "outbound" as const,
    durationSeconds: 221,
    date: "Yesterday",
    hasTranscript: true,
    transcript: "Confirmed access window and decision-maker list for the pre-bid walk.",
  },
  {
    id: "rec-103",
    contactName: "Tina Shaw",
    contactInitials: "TS",
    direction: "inbound" as const,
    durationSeconds: 98,
    date: "Tue",
    hasTranscript: false,
  },
  {
    id: "rec-104",
    contactName: "Oscar Patel",
    contactInitials: "OP",
    direction: "outbound" as const,
    durationSeconds: 444,
    date: "Mon",
    hasTranscript: false,
  },
];

const photos = [
  { id: "ph-1", label: "West parapet", takenBy: "Brett", takenAt: "Today" },
  { id: "ph-2", label: "Drainage field", takenBy: "Sarah", takenAt: "Yesterday" },
  { id: "ph-3", label: "Mechanical curb", takenBy: "Brett", takenAt: "Monday" },
];

const documents = [
  { id: "doc-1", name: "RFP package.pdf", kind: "RFP" as const, sizeKB: 1840, uploadedBy: "Mary", uploadedAt: "Today" },
  { id: "doc-2", name: "Estimate draft.xlsx", kind: "Estimate" as const, sizeKB: 740, uploadedBy: "Brett", uploadedAt: "Yesterday" },
  { id: "doc-3", name: "Roof plan set.pdf", kind: "Drawing" as const, sizeKB: 9216, uploadedBy: "Sarah", uploadedAt: "Monday" },
];

const companyTabs = [
  { key: "overview", label: "Overview", icon: <Home className="h-4 w-4" /> },
  { key: "contacts", label: "Contacts", icon: <Users className="h-4 w-4" />, count: 8 },
  { key: "properties", label: "Properties", icon: <Building2 className="h-4 w-4" />, count: 4 },
  { key: "deals", label: "Deals & Leads", icon: <Handshake className="h-4 w-4" />, count: 6 },
  { key: "email", label: "Email", icon: <Mail className="h-4 w-4" />, count: 12 },
  { key: "recordings", label: "Recordings", icon: <Mic className="h-4 w-4" />, count: 3 },
  { key: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "notes", label: "Notes", icon: <NotebookPen className="h-4 w-4" /> },
  { key: "files", label: "Files", icon: <FolderOpen className="h-4 w-4" />, count: 9 },
] as const;

const contactTabs = [
  { key: "overview", label: "Overview", icon: <Home className="h-4 w-4" /> },
  { key: "linkedDeals", label: "Linked deals", icon: <Briefcase className="h-4 w-4" />, count: 2 },
  { key: "email", label: "Email", icon: <Mail className="h-4 w-4" />, count: 5 },
  { key: "recordings", label: "Recordings", icon: <Mic className="h-4 w-4" />, count: 4 },
  { key: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "notes", label: "Notes", icon: <NotebookPen className="h-4 w-4" /> },
  { key: "files", label: "Files", icon: <FolderOpen className="h-4 w-4" />, count: 3 },
] as const;

const propertyTabs = [
  { key: "overview", label: "Overview", icon: <Home className="h-4 w-4" /> },
  { key: "activeDeal", label: "Active deal", icon: <Briefcase className="h-4 w-4" /> },
  { key: "history", label: "History", icon: <Archive className="h-4 w-4" /> },
  { key: "email", label: "Email", icon: <Mail className="h-4 w-4" /> },
  { key: "recordings", label: "Recordings", icon: <Mic className="h-4 w-4" /> },
  { key: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "files", label: "Files", icon: <FolderOpen className="h-4 w-4" /> },
] as const;

const dealTabs = [
  { key: "overview", label: "Overview", icon: <Home className="h-4 w-4" /> },
  { key: "stageHistory", label: "Stage history", icon: <Calendar className="h-4 w-4" /> },
  { key: "estimate", label: "Estimate", icon: <FileText className="h-4 w-4" /> },
  { key: "email", label: "Email", icon: <Mail className="h-4 w-4" /> },
  { key: "recordings", label: "Recordings", icon: <Mic className="h-4 w-4" /> },
  { key: "photos", label: "Photos", icon: <Camera className="h-4 w-4" />, count: 5 },
  { key: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { key: "files", label: "Files", icon: <FolderOpen className="h-4 w-4" />, count: 4 },
] as const;

function HarnessCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="border-slate-200 bg-white shadow-none">
      <CardHeader>
        <CardTitle className="text-base font-black uppercase text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function SharedPrimitivesHarness() {
  const [scopeTwo, setScopeTwo] = useState("Mine");
  const [scopeThree, setScopeThree] = useState("Team");
  const [scopeFour, setScopeFour] = useState("QTD");
  const [companyTab, setCompanyTab] = useState<(typeof companyTabs)[number]["key"]>("overview");
  const [contactTab, setContactTab] = useState<(typeof contactTabs)[number]["key"]>("overview");
  const [propertyTab, setPropertyTab] = useState<(typeof propertyTabs)[number]["key"]>("overview");
  const [dealTab, setDealTab] = useState<(typeof dealTabs)[number]["key"]>("overview");

  return (
    <div className="space-y-6">
      <div>
        <Eyebrow>Track B harness</Eyebrow>
        <h1 className="mt-2 text-3xl font-black uppercase leading-none text-slate-950">Shared primitives</h1>
      </div>

      <HarnessCard title="MetricCard tones and accents">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard eyebrow="Active deals" value={String(repDashboardMock.activeDeals.count)} badge={USD_COMPACT(repDashboardMock.activeDeals.totalValue)} caption="Pipeline" tone="green" accent="red" />
          <MetricCard eyebrow="Active leads" value={String(repDashboardMock.activeLeads.count)} badge={`${repDashboardMock.followUpCompliance.complianceRate}%`} caption="Follow-up" tone="blue" accent="blue" />
          <MetricCard eyebrow="Tasks today" value={String(repDashboardMock.tasksToday.today)} badge={`${repDashboardMock.tasksToday.overdue} late`} caption="Due now" tone="white" accent="green" />
          <MetricCard eyebrow="Commission YTD" value={USD_COMPACT(repDashboardMock.commissionSummary.earnedYtd)} badge="YTD" caption="Drenched red" tone="red" accent="amber" />
        </div>
      </HarnessCard>

      <HarnessCard title="ScopeToggle option counts">
        <div className="flex flex-wrap gap-4">
          <ScopeToggle options={[{ value: "Mine", label: "Mine" }, { value: "All", label: "All" }]} value={scopeTwo} onChange={setScopeTwo} />
          <ScopeToggle options={[{ value: "Mine", label: "Mine", count: 12 }, { value: "Team", label: "Team", count: 28 }, { value: "All", label: "All", count: 42 }]} value={scopeThree} onChange={setScopeThree} />
          <ScopeToggle options={[{ value: "MTD", label: "MTD" }, { value: "QTD", label: "QTD" }, { value: "YTD", label: "YTD" }, { value: "All", label: "All" }]} value={scopeFour} onChange={setScopeFour} />
        </div>
      </HarnessCard>

      <HarnessCard title="DetailTabs variants">
        <div className="space-y-5">
          <DetailTabs tabs={[...companyTabs]} active={companyTab} onChange={setCompanyTab} />
          <DetailTabs tabs={[...contactTabs]} active={contactTab} onChange={setContactTab} />
          <DetailTabs tabs={[...propertyTabs]} active={propertyTab} onChange={setPropertyTab} />
          <DetailTabs tabs={[...dealTabs]} active={dealTab} onChange={setDealTab} />
        </div>
      </HarnessCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <HarnessCard title="ActivityTimeline">
          <ActivityTimeline items={activityItems} />
        </HarnessCard>
        <HarnessCard title="Hook-shaped dashboard mock fields">
          <div className="grid gap-3 sm:grid-cols-2">
            {repDashboardMock.funnelBuckets.map((bucket) => (
              <div key={bucket.label} className="rounded-md border border-slate-200 p-3">
                <p className="text-2xl font-black tabular-nums text-slate-950">{bucket.count}</p>
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{bucket.label}</p>
              </div>
            ))}
          </div>
        </HarnessCard>
      </div>

      <HarnessCard title="EmailList">
        <EmailList emails={emailRows} />
      </HarnessCard>

      <HarnessCard title="RecordingsList">
        <RecordingsList recordings={recordings} />
      </HarnessCard>

      <HarnessCard title="FilesView">
        <FilesView photos={photos} documents={documents} />
      </HarnessCard>
    </div>
  );
}
