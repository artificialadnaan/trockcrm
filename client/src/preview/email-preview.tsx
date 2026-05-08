import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  Plus,
  Reply,
  Forward,
  Archive,
  Trash2,
  Inbox,
  Send,
  Link2,
  AlertTriangle,
  Star,
  Mail,
  Paperclip,
  X,
  Sparkles,
  Building2,
  Briefcase,
  Handshake,
  ClipboardList,
  Users,
  MapPin,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EYEBROW, MetricCard } from "./preview-shared";

type LinkType = "deal" | "lead" | "contact" | "company" | "property";

type LinkedRecord = {
  type: LinkType;
  id: string;
  name: string;
};

type EmailItem = {
  id: string;
  fromName: string;
  fromEmail: string;
  fromInitials: string;
  fromMe: boolean;
  subject: string;
  preview: string;
  body: string;
  receivedAt: string;
  receivedTimestamp: number;
  unread: boolean;
  hasAttachment?: boolean;
  attachmentCount?: number;
  linked?: LinkedRecord[];
  needsAssignment: boolean;
  matchConfidence?: "high" | "low" | "none";
  matchReason?: string;
  suggestions?: LinkedRecord[];
};

const fixtureEmails: EmailItem[] = [
  {
    id: "e1",
    fromName: "Marcus Holloway",
    fromEmail: "mholloway@dallasisd.org",
    fromInitials: "MH",
    fromMe: false,
    subject: "RE: Building A roof phase 2 timeline",
    preview: "Confirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting.",
    body: "Brett,\n\nConfirmed the phasing window — June 15 through August 3. Need bid pricing locked by May 28 to clear the board meeting on the 30th. Please send the revised SOV with drain replacement broken out as a line item; procurement asked specifically for that.\n\nWalk Friday at 8:30am still works.\n\n— Marcus\n\nMarcus Holloway\nDirector of Facilities\nDallas Independent SD\n(214) 555-0102",
    receivedAt: "2h ago",
    receivedTimestamp: 7_200,
    unread: true,
    hasAttachment: true,
    attachmentCount: 2,
    linked: [
      { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" },
      { type: "contact", id: "1", name: "Marcus Holloway" },
      { type: "company", id: "1", name: "Dallas Independent SD" },
    ],
    needsAssignment: false,
    matchConfidence: "high",
  },
  {
    id: "e2",
    fromName: "Karen Vu",
    fromEmail: "kvu@dallasisd.org",
    fromInitials: "KV",
    fromMe: false,
    subject: "PO question — Skyline auditorium",
    preview: "Hi Brett, the PO for the Skyline closeout came through with a different cost code than what we discussed. Can you...",
    body: "Hi Brett,\n\nThe PO for the Skyline closeout came through with a different cost code than what we discussed. Can you confirm what should land on each invoice line so I can route to the correct fund?\n\nThanks,\nKaren",
    receivedAt: "3 days ago",
    receivedTimestamp: 259_200,
    unread: false,
    linked: [{ type: "company", id: "1", name: "Dallas Independent SD" }],
    needsAssignment: false,
    matchConfidence: "low",
    matchReason: "Matched by domain only",
  },
  {
    id: "e3",
    fromName: "Linda Park",
    fromEmail: "lpark@friscologistics.com",
    fromInitials: "LP",
    fromMe: false,
    subject: "Frisco DC re-roof — checking timing",
    preview: "Brett, our board meets next Tuesday and I want to bring your bid. Will the timeline you sent last week still hold...",
    body: "Brett,\n\nOur board meets next Tuesday and I want to bring your bid. Will the timeline you sent last week still hold given the rain delays?\n\nLinda",
    receivedAt: "5h ago",
    receivedTimestamp: 18_000,
    unread: true,
    linked: [
      { type: "deal", id: "2", name: "Frisco Distribution Center" },
      { type: "contact", id: "2", name: "Linda Park" },
    ],
    needsAssignment: false,
    matchConfidence: "high",
  },
  {
    id: "e4",
    fromName: "homedepotpro@order.homedepot.com",
    fromEmail: "homedepotpro@order.homedepot.com",
    fromInitials: "HD",
    fromMe: false,
    subject: "Part of your order has been delivered!",
    preview: "Order # H6549-510255 Order Date: Apr 27, 2026 Your delivery has arrived, Brett.",
    body: "Order # H6549-510255 Order Date: Apr 27, 2026\n\nYour delivery has arrived, Brett. This order will be delivered in multiple shipments. Your item(s) arrived today.",
    receivedAt: "today, 10:08 AM",
    receivedTimestamp: 5_400,
    unread: true,
    needsAssignment: true,
    matchConfidence: "none",
    matchReason: "No safe match found",
    suggestions: [],
  },
  {
    id: "e5",
    fromName: "notification@txn.getjobber.com",
    fromEmail: "notification@txn.getjobber.com",
    fromInitials: "TV",
    fromMe: false,
    subject: "Your invoice from Trinity Valley Plumbing Services is due today",
    preview: "Hi T Rock Construction, This is a reminder that payment on Invoice #1396 is due today.",
    body: "Hi T Rock Construction,\n\nThis is a reminder that payment on Invoice #1396 is due today.\n\nIf the payment has already been sent, please ignore this email.\n\n— Trinity Valley Plumbing Services",
    receivedAt: "today, 8:02 AM",
    receivedTimestamp: 14_400,
    unread: true,
    needsAssignment: true,
    matchConfidence: "low",
    matchReason: "Possible vendor match",
    suggestions: [
      { type: "company", id: "tv", name: "Trinity Valley Plumbing (vendor)" },
    ],
  },
  {
    id: "e6",
    fromName: "Brett Rios",
    fromEmail: "brett@trockconstruction.com",
    fromInitials: "BR",
    fromMe: true,
    subject: "Updated SOV - Dallas ISD Bldg A",
    preview: "Marcus, attached the revised SOV with the drain replacement line items broken out.",
    body: "Marcus,\n\nAttached the revised SOV with the drain replacement line items broken out. Let me know if the procurement office needs additional detail.\n\nBrett",
    receivedAt: "yesterday",
    receivedTimestamp: 86_400,
    unread: false,
    hasAttachment: true,
    attachmentCount: 1,
    linked: [
      { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" },
      { type: "contact", id: "1", name: "Marcus Holloway" },
    ],
    needsAssignment: false,
    matchConfidence: "high",
  },
  {
    id: "e7",
    fromName: "Greg Holland",
    fromEmail: "greg@westlakeholdings.com",
    fromInitials: "GH",
    fromMe: false,
    subject: "Westlake Industrial — initial scope",
    preview: "Brett, here's the initial scope document for the building 7 re-roof. Please review and let me know your...",
    body: "Brett,\n\nHere's the initial scope document for the building 7 re-roof. Please review and let me know your initial pricing thoughts before we open formal bidding.\n\nGreg",
    receivedAt: "today, 7:45 AM",
    receivedTimestamp: 16_200,
    unread: true,
    hasAttachment: true,
    attachmentCount: 1,
    linked: [],
    needsAssignment: true,
    matchConfidence: "low",
    matchReason: "AI suggests new lead from Westlake Holdings",
    suggestions: [
      { type: "company", id: "3", name: "Westlake Holdings" },
      { type: "lead", id: "1", name: "Westlake Industrial Park" },
    ],
  },
  {
    id: "e8",
    fromName: "Susan Albright",
    fromEmail: "susan@planotowerlp.com",
    fromInitials: "SA",
    fromMe: false,
    subject: "Plano Tower — addendum 1",
    preview: "Sending addendum 1 to the Plano office tower bid. Please acknowledge receipt.",
    body: "Brett,\n\nSending addendum 1 to the Plano office tower bid. Please acknowledge receipt and incorporate into final pricing.\n\nSusan",
    receivedAt: "yesterday",
    receivedTimestamp: 86_400 + 7_200,
    unread: false,
    hasAttachment: true,
    attachmentCount: 1,
    linked: [
      { type: "deal", id: "3", name: "Plano Office Tower Re-Cover" },
      { type: "contact", id: "4", name: "Susan Albright" },
    ],
    needsAssignment: false,
    matchConfidence: "high",
  },
  {
    id: "e9",
    fromName: "Roy Bautista",
    fromEmail: "rbautista@arlingtontx.gov",
    fromInitials: "RB",
    fromMe: false,
    subject: "Civic Center contract — final routing",
    preview: "Brett, the city manager signed off on the Arlington Civic Center contract this morning.",
    body: "Brett,\n\nThe city manager signed off on the Arlington Civic Center contract this morning. The signed PDF should reach you within 24 hours.\n\nRoy",
    receivedAt: "3 days ago",
    receivedTimestamp: 259_200,
    unread: false,
    linked: [
      { type: "deal", id: "4", name: "Arlington Civic Center" },
      { type: "contact", id: "5", name: "Roy Bautista" },
      { type: "company", id: "5", name: "City of Arlington" },
    ],
    needsAssignment: false,
    matchConfidence: "high",
  },
  {
    id: "e10",
    fromName: "billing@quickbooks.intuit.com",
    fromEmail: "billing@quickbooks.intuit.com",
    fromInitials: "QB",
    fromMe: false,
    subject: "Your monthly QuickBooks subscription receipt",
    preview: "Thanks for your business — receipt for $89.00 attached.",
    body: "Thanks for your business — receipt for $89.00 attached.",
    receivedAt: "5 days ago",
    receivedTimestamp: 432_000,
    unread: false,
    hasAttachment: true,
    attachmentCount: 1,
    needsAssignment: true,
    matchConfidence: "none",
    matchReason: "Routine vendor mail",
    suggestions: [],
  },
];

type Filter = "all" | "unread" | "unassigned" | "sent";

const linkTypeMeta: Record<
  LinkType,
  { icon: typeof Briefcase; label: string; route: (id: string) => string; tone: string }
> = {
  deal: { icon: Briefcase, label: "Deal", route: (id) => `/deals/${id}`, tone: "bg-brand-red/10 text-brand-red ring-brand-red/20" },
  lead: { icon: ClipboardList, label: "Lead", route: (id) => `/leads/${id}`, tone: "bg-blue-50 text-blue-700 ring-blue-200" },
  contact: { icon: Users, label: "Contact", route: (id) => `/contacts/${id}`, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  company: { icon: Building2, label: "Company", route: (id) => `/companies/${id}`, tone: "bg-amber-50 text-amber-700 ring-amber-200" },
  property: { icon: MapPin, label: "Property", route: (id) => `/properties/${id}`, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

function LinkChip({ link, onClick }: { link: LinkedRecord; onClick?: () => void }) {
  const meta = linkTypeMeta[link.type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 transition-opacity hover:opacity-80 ${meta.tone}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate normal-case tracking-normal">{link.name}</span>
    </button>
  );
}

function AssignPopover({
  email,
  onClose,
  onAssign,
}: {
  email: EmailItem;
  onClose: () => void;
  onAssign: (link: LinkedRecord) => void;
}) {
  const [activeType, setActiveType] = useState<LinkType>("deal");
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const candidates: LinkedRecord[] = useMemo(() => {
    const fakeIndex: Record<LinkType, LinkedRecord[]> = {
      deal: [
        { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" },
        { type: "deal", id: "2", name: "Frisco Distribution Center" },
        { type: "deal", id: "3", name: "Plano Office Tower Re-Cover" },
        { type: "deal", id: "4", name: "Arlington Civic Center" },
      ],
      lead: [
        { type: "lead", id: "1", name: "Westlake Industrial Park" },
        { type: "lead", id: "3", name: "Mesquite Retail Center" },
      ],
      contact: [
        { type: "contact", id: "1", name: "Marcus Holloway" },
        { type: "contact", id: "2", name: "Linda Park" },
        { type: "contact", id: "9", name: "Greg Holland" },
      ],
      company: [
        { type: "company", id: "1", name: "Dallas Independent SD" },
        { type: "company", id: "2", name: "Frisco Logistics Co." },
        { type: "company", id: "3", name: "Westlake Holdings" },
      ],
      property: [
        { type: "property", id: "1", name: "Building A - Main Campus" },
        { type: "property", id: "2", name: "Frisco Distribution Center" },
      ],
    };
    return fakeIndex[activeType].filter((c) =>
      search.trim() ? c.name.toLowerCase().includes(search.toLowerCase()) : true
    );
  }, [activeType, search]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-2 w-[26rem] overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-sm font-bold text-slate-950">Assign email</p>
          <p className="mt-0.5 text-xs text-slate-500">{email.subject}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {email.suggestions && email.suggestions.length > 0 ? (
        <div className="border-b border-slate-100 bg-blue-50/30 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-blue-700" />
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">AI suggestions</p>
          </div>
          <div className="mt-2 space-y-1">
            {email.suggestions.map((s) => (
              <button
                key={`${s.type}-${s.id}`}
                type="button"
                onClick={() => onAssign(s)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-blue-100"
              >
                <LinkChip link={s} />
                <CheckCircle2 className="h-4 w-4 text-blue-700" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-slate-100 px-4 py-2">
        {(["deal", "lead", "contact", "company", "property"] as LinkType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveType(t)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
              activeType === t ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {linkTypeMeta[t].label}
          </button>
        ))}
      </div>

      <div className="border-b border-slate-100 px-4 py-2">
        <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${linkTypeMeta[activeType].label.toLowerCase()}s`}
            className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            No {linkTypeMeta[activeType].label.toLowerCase()}s found.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {candidates.map((c) => (
              <li key={`${c.type}-${c.id}`}>
                <button
                  type="button"
                  onClick={() => onAssign(c)}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-slate-50"
                >
                  <span className="truncate text-sm font-semibold text-slate-950">{c.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ email }: { email: EmailItem }) {
  if (email.fromMe) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
        <Send className="h-2.5 w-2.5" />
        Sent
      </span>
    );
  }
  if (email.needsAssignment) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
        <AlertTriangle className="h-2.5 w-2.5" />
        Unassigned
      </span>
    );
  }
  if (email.matchConfidence === "low") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
        <Sparkles className="h-2.5 w-2.5" />
        Low confidence
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
      <Link2 className="h-2.5 w-2.5" />
      Linked
    </span>
  );
}

export function EmailPreview() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>(fixtureEmails[0]!.id);
  const [assignOpenFor, setAssignOpenFor] = useState<string | null>(null);
  const [emails, setEmails] = useState<EmailItem[]>(fixtureEmails);

  const filtered = useMemo(() => {
    return emails.filter((e) => {
      if (filter === "unread" && !e.unread) return false;
      if (filter === "unassigned" && !e.needsAssignment) return false;
      if (filter === "sent" && !e.fromMe) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !e.subject.toLowerCase().includes(q) &&
          !e.fromName.toLowerCase().includes(q) &&
          !e.fromEmail.toLowerCase().includes(q) &&
          !e.preview.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [emails, filter, search]);

  const selected = emails.find((e) => e.id === selectedId) ?? filtered[0] ?? null;

  const counts = useMemo(() => {
    return {
      unread: emails.filter((e) => e.unread).length,
      unassigned: emails.filter((e) => e.needsAssignment).length,
      linkedToday: emails.filter((e) => !e.needsAssignment && !e.fromMe).length,
    };
  }, [emails]);

  const assignLink = (emailId: string, link: LinkedRecord) => {
    setEmails((current) =>
      current.map((e) =>
        e.id === emailId
          ? { ...e, needsAssignment: false, matchConfidence: "high", linked: [...(e.linked ?? []), link] }
          : e
      )
    );
    setAssignOpenFor(null);
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Email</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Inbox · {counts.unread} unread · {counts.unassigned} need attention
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="lg">
            <Mail className="mr-1.5 h-4 w-4" />
            Connect Microsoft 365
          </Button>
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            Compose
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Unread"
          value={String(counts.unread)}
          badge={`${emails.filter((e) => e.unread && e.matchConfidence === "high").length} high priority`}
          badgeTone="green"
          caption="Inbox"
          accent="red"
        />
        <MetricCard
          eyebrow="Today"
          value={String(emails.filter((e) => e.receivedAt.startsWith("today") || e.receivedAt.endsWith("h ago")).length)}
          badge={`${counts.linkedToday} auto-linked`}
          badgeTone="blue"
          caption="Last 24 hours"
          accent="blue"
        />
        <MetricCard
          eyebrow="Need attention"
          value={String(counts.unassigned)}
          badge="parking lot"
          drenched
          caption="Unassigned · low confidence"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
            {(
              [
                { key: "all", label: "All", icon: Inbox, count: emails.length },
                { key: "unread", label: "Unread", icon: Mail, count: counts.unread },
                { key: "unassigned", label: "Unassigned", icon: AlertTriangle, count: counts.unassigned },
                { key: "sent", label: "Sent", icon: Send, count: emails.filter((e) => e.fromMe).length },
              ] as const
            ).map((f) => {
              const Icon = f.icon;
              const isActive = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors ${
                    isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {f.label}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
                      isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {f.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search inbox"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              Sender
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <div className="max-h-[640px] overflow-y-auto border-b border-slate-100 lg:border-b-0 lg:border-r">
            {filtered.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-slate-500">No emails match these filters.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filtered.map((e) => {
                  const isSelected = selected?.id === e.id;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(e.id)}
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                          isSelected ? "bg-brand-red/5" : "hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-black uppercase text-white ${
                            e.fromMe ? "bg-slate-900" : "bg-brand-red"
                          }`}
                        >
                          {e.fromInitials}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p
                              className={`truncate text-sm ${
                                e.unread ? "font-black text-slate-950" : "font-semibold text-slate-700"
                              }`}
                            >
                              {e.fromMe ? "You" : e.fromName}
                            </p>
                            <p className="shrink-0 text-[10px] font-semibold tabular-nums text-slate-500">
                              {e.receivedAt}
                            </p>
                          </div>
                          <p className={`mt-0.5 truncate text-sm ${e.unread ? "font-black text-slate-950" : "font-bold text-slate-700"}`}>
                            {e.subject}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">{e.preview}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <StatusPill email={e} />
                            {e.unread ? <span className="h-1.5 w-1.5 rounded-full bg-brand-red" aria-label="Unread" /> : null}
                            {e.hasAttachment ? (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-slate-500">
                                <Paperclip className="h-2.5 w-2.5" />
                                {e.attachmentCount}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="min-h-[640px]">
            {selected ? <EmailDetailPane
              email={selected}
              navigate={navigate}
              onAssignClick={() => setAssignOpenFor(selected.id)}
              assignOpen={assignOpenFor === selected.id}
              onCloseAssign={() => setAssignOpenFor(null)}
              onAssign={(link) => assignLink(selected.id, link)}
            /> : (
              <div className="flex h-full items-center justify-center p-12">
                <div className="text-center">
                  <Mail className="mx-auto h-8 w-8 text-slate-400" />
                  <p className="mt-2 text-sm text-slate-500">Select an email to read</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function EmailDetailPane({
  email,
  navigate,
  onAssignClick,
  assignOpen,
  onCloseAssign,
  onAssign,
}: {
  email: EmailItem;
  navigate: (path: string) => void;
  onAssignClick: () => void;
  assignOpen: boolean;
  onCloseAssign: () => void;
  onAssign: (link: LinkedRecord) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-black tracking-tight text-slate-950">{email.subject}</h2>
            <div className="mt-2 flex items-center gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-black uppercase text-white ${
                  email.fromMe ? "bg-slate-900" : "bg-brand-red"
                }`}
              >
                {email.fromInitials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-950">
                  {email.fromMe ? "You" : email.fromName}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {email.fromMe ? "→" : "from"} {email.fromEmail} · {email.receivedAt}
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Star"
            >
              <Star className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Archive"
            >
              <Archive className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-slate-100 px-6 py-3">
        {email.needsAssignment ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
              <div>
                <p className="text-sm font-bold text-amber-900">Not linked to a record</p>
                <p className="text-xs text-amber-800">
                  {email.matchReason ?? "Assign once and this thread stays linked for future replies."}
                </p>
              </div>
            </div>
            <div className="relative">
              <Button size="sm" onClick={onAssignClick}>
                <Link2 className="mr-1 h-4 w-4" />
                Assign
              </Button>
              {assignOpen ? (
                <AssignPopover email={email} onClose={onCloseAssign} onAssign={onAssign} />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`${EYEBROW} self-center`}>Linked to:</p>
              {(email.linked ?? []).map((l) => (
                <LinkChip
                  key={`${l.type}-${l.id}`}
                  link={l}
                  onClick={() => navigate(linkTypeMeta[l.type].route(l.id))}
                />
              ))}
            </div>
            <div className="relative">
              <Button variant="outline" size="sm" onClick={onAssignClick}>
                <Link2 className="mr-1 h-4 w-4" />
                Reassign
              </Button>
              {assignOpen ? (
                <AssignPopover email={email} onClose={onCloseAssign} onAssign={onAssign} />
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="prose prose-sm max-w-none whitespace-pre-line text-sm leading-relaxed text-slate-700">
          {email.body}
        </div>

        {email.hasAttachment ? (
          <div className="mt-6 border-t border-slate-100 pt-4">
            <p className={EYEBROW}>{email.attachmentCount} attachment{(email.attachmentCount ?? 0) === 1 ? "" : "s"}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {Array.from({ length: email.attachmentCount ?? 1 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/40 p-3"
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-slate-500" />
                  <p className="truncate text-xs font-bold text-slate-950">attachment-{i + 1}.pdf</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 px-6 py-3">
        <Button size="sm">
          <Reply className="mr-1 h-4 w-4" />
          Reply
        </Button>
        <Button variant="outline" size="sm">
          <Forward className="mr-1 h-4 w-4" />
          Forward
        </Button>
      </div>
    </div>
  );
}
