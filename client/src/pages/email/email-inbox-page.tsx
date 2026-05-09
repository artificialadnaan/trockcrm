import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DOMPurify from "dompurify";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  Filter,
  Forward,
  Inbox,
  Link2,
  Mail,
  Paperclip,
  Plus,
  Reply,
  Search,
  Send,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GraphAuthBanner } from "@/components/email/graph-auth-banner";
import { EmailAssignmentQueuePanel, useEmailAssignmentQueue } from "@/components/email/email-assignment-queue";
import { EmailComposeDialog } from "@/components/email/email-compose-dialog";
import { EmailManualAssignmentDialog } from "@/components/email/email-manual-assignment-dialog";
import { EmailThreadView } from "@/components/email/email-thread-view";
import { useGraphAuth } from "@/hooks/use-graph-auth";
import {
  associateEmailToEntity,
  updateEmailAction,
  useUserEmails,
  type Email,
} from "@/hooks/use-emails";
import { cn } from "@/lib/utils";

type EmailFilter = "all" | "unread" | "unassigned" | "sent" | "parking-lot";

const FILTERS: Array<{
  key: EmailFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { key: "all", label: "All", icon: Inbox },
  { key: "unread", label: "Unread", icon: Mail },
  { key: "unassigned", label: "Unassigned", icon: AlertTriangle },
  { key: "sent", label: "Sent", icon: Send },
  { key: "parking-lot", label: "Parking Lot Intake", icon: AlertTriangle },
];

function getDisplayName(email: Email) {
  if (email.direction === "outbound") return "You";
  return email.fromAddress.split("@")[0]?.replace(/[._-]/g, " ") || email.fromAddress;
}

function getInitials(email: Email) {
  if (email.direction === "outbound") return "TR";
  const name = getDisplayName(email);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return initials.toUpperCase() || "EM";
}

function getRelativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recent";

  const now = Date.now();
  const diffMs = now - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < hour) return `${Math.max(1, Math.round(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.round(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.round(diffMs / day)}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isLinked(email: Email) {
  return Boolean(email.assignedEntityId || email.dealId || email.contactId);
}

function needsAttention(email: Email) {
  return email.direction === "inbound" && !isLinked(email);
}

function buildForwardSubject(subject: string | null) {
  const trimmed = subject?.trim() || "(No Subject)";
  return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

function htmlToPlainText(html: string | null | undefined) {
  if (!html) return "";
  const container = document.createElement("div");
  container.innerHTML = DOMPurify.sanitize(html);
  return container.textContent?.trim() ?? "";
}

function buildForwardBody(email: Email) {
  const originalBody = htmlToPlainText(email.bodyHtml) || email.bodyPreview || "";
  const recipients = email.toAddresses.join(", ") || "recipient";
  return [
    "",
    "",
    "---------- Forwarded message ---------",
    `From: ${email.fromAddress}`,
    `Date: ${new Date(email.sentAt).toLocaleString()}`,
    `Subject: ${email.subject ?? "(No Subject)"}`,
    `To: ${recipients}`,
    "",
    originalBody,
  ].join("\n");
}

function EmailMetricCard({
  eyebrow,
  value,
  badge,
  caption,
  accent = "red",
  drenched = false,
}: {
  eyebrow: string;
  value: string;
  badge: string;
  caption: string;
  accent?: "red" | "blue";
  drenched?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border p-4",
        drenched ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
      )}
    >
      <p
        className={cn(
          "text-[11px] font-black uppercase tracking-[0.18em]",
          drenched ? "text-slate-300" : "text-slate-500"
        )}
      >
        {eyebrow}
      </p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-4xl font-black tracking-tight">{value}</p>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em]",
            drenched
              ? "bg-white/10 text-white"
              : accent === "blue"
                ? "bg-blue-50 text-blue-700 ring-1 ring-blue-100"
                : "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20"
          )}
        >
          {badge}
        </span>
      </div>
      <p className={cn("mt-2 text-xs font-semibold", drenched ? "text-slate-300" : "text-slate-500")}>
        {caption}
      </p>
      {!drenched ? (
        <div className={cn("absolute inset-x-0 bottom-0 h-1", accent === "blue" ? "bg-blue-500" : "bg-brand-red")} />
      ) : null}
    </div>
  );
}

function StatusPill({ email }: { email: Email }) {
  if (email.direction === "outbound") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-700 ring-1 ring-slate-200">
        <Send className="h-2.5 w-2.5" />
        Sent
      </span>
    );
  }

  if (needsAttention(email)) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
        <AlertTriangle className="h-2.5 w-2.5" />
        Unassigned
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

function ThreadListItem({
  email,
  selected,
  onSelect,
}: {
  email: Email;
  selected: boolean;
  onSelect: () => void;
}) {
  const attention = needsAttention(email);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
          selected ? "bg-brand-red/5" : "hover:bg-slate-50"
        )}
      >
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-black uppercase text-white",
            email.direction === "outbound" ? "bg-slate-900" : "bg-brand-red"
          )}
        >
          {getInitials(email)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className={cn(
                "truncate text-sm",
                attention ? "font-black text-slate-950" : "font-semibold text-slate-700"
              )}
            >
              {getDisplayName(email)}
            </p>
            <p className="shrink-0 text-[10px] font-semibold tabular-nums text-slate-500">
              {getRelativeDate(email.sentAt)}
            </p>
          </div>
          <p className={cn("mt-0.5 truncate text-sm", attention ? "font-black text-slate-950" : "font-bold text-slate-700")}>
            {email.subject ?? "(No Subject)"}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">{email.bodyPreview ?? ""}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill email={email} />
            {attention ? <span className="h-1.5 w-1.5 rounded-full bg-brand-red" aria-label="Unread" /> : null}
            {email.hasAttachments ? (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-slate-500">
                <Paperclip className="h-2.5 w-2.5" />
                ATT
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

function EmailReaderPane({
  email,
  onReply,
  onForward,
  onRefresh,
}: {
  email: Email | null;
  onReply: (email: Email) => void;
  onForward: (email: Email) => void;
  onRefresh: () => void;
}) {
  const [showThreadTools, setShowThreadTools] = useState(false);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [actionPending, setActionPending] = useState<"star" | "archive" | "delete" | null>(null);

  useEffect(() => {
    setShowThreadTools(false);
    setManualDialogOpen(false);
    setActionPending(null);
  }, [email?.id]);

  if (!email) {
    return (
      <div className="flex h-full min-h-[640px] items-center justify-center p-12">
        <div className="text-center">
          <Mail className="mx-auto h-8 w-8 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">Select an email to read</p>
        </div>
      </div>
    );
  }

  const currentEmail = email;
  const fromMe = email.direction === "outbound";
  const recipientLine = fromMe ? `to ${email.toAddresses.join(", ") || "recipient"}` : `from ${email.fromAddress}`;

  async function handleReaderAction(action: "star" | "archive" | "delete") {
    if (action === "delete" && !window.confirm("Delete this email from your inbox?")) return;

    setActionPending(action);
    try {
      if (action === "star") {
        await updateEmailAction(currentEmail.id, { isStarred: !currentEmail.isStarred });
        toast.success(currentEmail.isStarred ? "Email unstarred" : "Email starred");
      } else if (action === "archive") {
        await updateEmailAction(currentEmail.id, { archived: true });
        toast.success("Email archived");
      } else {
        await updateEmailAction(currentEmail.id, { deleted: true });
        toast.success("Email deleted");
      }
      onRefresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Email action failed");
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div className="flex h-full min-h-[640px] flex-col">
      <div className="border-b border-slate-100 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-black tracking-tight text-slate-950">
              {email.subject ?? "(No Subject)"}
            </h2>
            <div className="mt-2 flex items-center gap-3">
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-black uppercase text-white",
                  fromMe ? "bg-slate-900" : "bg-brand-red"
                )}
              >
                {getInitials(email)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-950">
                  {fromMe ? "You" : getDisplayName(email)}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {recipientLine} · {getRelativeDate(email.sentAt)}
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={actionPending === "star"}
              onClick={() => void handleReaderAction("star")}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50",
                email.isStarred ? "text-amber-500" : null
              )}
              aria-label={email.isStarred ? "Unstar" : "Star"}
              aria-pressed={email.isStarred}
            >
              <Star className={cn("h-4 w-4", email.isStarred ? "fill-current" : null)} />
            </button>
            <button
              type="button"
              disabled={actionPending === "archive"}
              onClick={() => void handleReaderAction("archive")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
              aria-label="Archive"
            >
              <Archive className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={actionPending === "delete"}
              onClick={() => void handleReaderAction("delete")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
              aria-label="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-slate-100 px-6 py-3">
        {needsAttention(email) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
              <div>
                <p className="text-sm font-bold text-amber-900">Not linked to a record</p>
                <p className="text-xs text-amber-800">Review the parking lot intake to attach this message.</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-amber-800 ring-1 ring-amber-200">
              <Sparkles className="h-3 w-3" />
              Needs review
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Linked to:</p>
            {email.dealId ? (
              <span className="rounded-full bg-brand-red/10 px-2.5 py-1 text-[11px] font-bold text-brand-red ring-1 ring-brand-red/20">
                Deal
              </span>
            ) : null}
            {email.contactId ? (
              <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-bold text-violet-700 ring-1 ring-violet-200">
                Contact
              </span>
            ) : null}
            {!email.dealId && !email.contactId ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 ring-1 ring-slate-200">
                CRM email
              </span>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div
          className="prose prose-sm max-w-none text-sm leading-relaxed text-slate-700"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(email.bodyHtml ?? email.bodyPreview ?? ""),
          }}
        />

        {email.hasAttachments ? (
          <div className="mt-6 border-t border-slate-100 pt-4">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Attachments</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/40 p-3">
                <Paperclip className="h-4 w-4 shrink-0 text-slate-500" />
                <p className="truncate text-xs font-bold text-slate-950">Message attachments</p>
              </div>
            </div>
          </div>
        ) : null}

        {email.graphConversationId && showThreadTools ? (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50/40 p-4">
            <EmailThreadView conversationId={email.graphConversationId} onBack={() => setShowThreadTools(false)} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-6 py-3">
        <Button size="sm" onClick={() => onReply(email)}>
          <Reply className="mr-1 h-4 w-4" />
          Reply
        </Button>
        <Button variant="outline" size="sm" onClick={() => onForward(email)}>
          <Forward className="mr-1 h-4 w-4" />
          Forward
        </Button>
        {email.graphConversationId ? (
          <Button variant="outline" size="sm" onClick={() => setShowThreadTools((value) => !value)}>
            <Link2 className="mr-1 h-4 w-4" />
            Thread tools
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setManualDialogOpen(true)}>
            <Link2 className="mr-1 h-4 w-4" />
            Reassign email
          </Button>
        )}
      </div>
      <EmailManualAssignmentDialog
        open={manualDialogOpen}
        onOpenChange={setManualDialogOpen}
        title="Reassign email"
        description="Search the CRM and attach this standalone email to any deal, lead, contact, company, or property."
        onAssign={async (target) => {
          await associateEmailToEntity(email.id, target);
          toast.success("Email reassigned");
          setManualDialogOpen(false);
          onRefresh();
        }}
      />
    </div>
  );
}

export function EmailInboxPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EmailFilter>("all");
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDefaults, setComposeDefaults] = useState<{
    to?: string;
    subject?: string;
    body?: string;
  }>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graphAuth = useGraphAuth();
  const parkingLotQueue = useEmailAssignmentQueue();
  const oauthConnected = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  const inboxFilter = filter === "parking-lot" ? "all" : filter;
  const { emails, pagination, counts: inboxCounts, loading, error, refetch } = useUserEmails({
    filter: inboxFilter,
    search: search.length >= 2 ? search : undefined,
    page,
    limit: 25,
  });

  const visibleEmails = useMemo(() => (filter === "parking-lot" ? [] : emails), [emails, filter]);
  const selectedEmail = visibleEmails.find((email) => email.id === selectedId) ?? visibleEmails[0] ?? null;

  const counts = useMemo(
    () => ({
      all: inboxCounts.all,
      unread: inboxCounts.unread,
      unassigned: inboxCounts.unassigned,
      sent: inboxCounts.sent,
      parkingLot: parkingLotQueue.pagination.total,
      linked: inboxCounts.linked,
      today: inboxCounts.today,
    }),
    [inboxCounts, parkingLotQueue.pagination.total]
  );

  useEffect(() => {
    if (selectedId && visibleEmails.some((email) => email.id === selectedId)) return;
    setSelectedId(visibleEmails[0]?.id ?? null);
  }, [selectedId, visibleEmails]);

  function handleFilterChange(nextFilter: EmailFilter) {
    setFilter(nextFilter);
    setPage(1);
  }

  function handleReply(email: Email) {
    setComposeDefaults({
      to: email.direction === "inbound" ? email.fromAddress : email.toAddresses[0],
    });
    setComposeOpen(true);
  }

  function handleForward(email: Email) {
    setComposeDefaults({
      subject: buildForwardSubject(email.subject),
      body: buildForwardBody(email),
    });
    setComposeOpen(true);
  }

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
          <Button variant="outline" size="lg" onClick={graphAuth.startConsent} disabled={graphAuth.connected || graphAuth.loading}>
            <Mail className="mr-1.5 h-4 w-4" />
            {graphAuth.connected ? "Connected" : "Microsoft 365"}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setComposeDefaults({});
              setComposeOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Compose
          </Button>
        </div>
      </section>

      {oauthConnected === "true" ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
          Microsoft email connected successfully.
        </div>
      ) : null}
      {oauthError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          Failed to connect email: {oauthError}
        </div>
      ) : null}

      <GraphAuthBanner auth={graphAuth} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <EmailMetricCard
          eyebrow="Unread"
          value={String(counts.unread)}
          badge={`${counts.unassigned} need review`}
          caption="Inbox"
        />
        <EmailMetricCard
          eyebrow="Today"
          value={String(counts.today)}
          badge={`${counts.linked} linked`}
          caption="Last 24 hours"
          accent="blue"
        />
        <EmailMetricCard
          eyebrow="Need attention"
          value={String(counts.unassigned)}
          badge="parking lot"
          drenched
          caption="Unassigned messages"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div
            data-email-filter-tabs
            className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5"
          >
            {FILTERS.map((item) => {
              const Icon = item.icon;
              const isActive = filter === item.key;
              const count = item.key === "parking-lot" ? counts.parkingLot : counts[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => handleFilterChange(item.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors",
                    isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums",
                      isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"
                    )}
                  >
                    {count}
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
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
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

        {error ? (
          <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm font-semibold text-red-700">{error}</div>
        ) : null}

        {filter === "parking-lot" ? (
          <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div className="border-b border-slate-100 p-5 lg:border-b-0 lg:border-r">
              <div className="rounded-md bg-slate-50 p-4">
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Parking Lot Intake</p>
                <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                  {parkingLotQueue.pagination.total}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-600">
                  unresolved email{parkingLotQueue.pagination.total === 1 ? "" : "s"} awaiting assignment
                </p>
              </div>
            </div>
            <div className="min-h-[640px]">
              <EmailAssignmentQueuePanel queue={parkingLotQueue} embedded />
            </div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div className="max-h-[640px] overflow-y-auto border-b border-slate-100 lg:border-b-0 lg:border-r">
              {loading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="h-20 animate-pulse rounded-md bg-slate-100" />
                  ))}
                </div>
              ) : visibleEmails.length === 0 ? (
                <p className="px-5 py-12 text-center text-sm text-slate-500">
                  No emails match these filters.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100" aria-label="Email threads">
                  {visibleEmails.map((email) => (
                    <ThreadListItem
                      key={email.id}
                      email={email}
                      selected={selectedEmail?.id === email.id}
                      onSelect={() => setSelectedId(email.id)}
                    />
                  ))}
                </ul>
              )}

              {pagination.totalPages > 1 ? (
                <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
                  <span className="text-xs font-semibold text-slate-500">
                    Page {pagination.page} of {pagination.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pagination.page <= 1}
                      onClick={() => setPage(pagination.page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pagination.page >= pagination.totalPages}
                      onClick={() => setPage(pagination.page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            <EmailReaderPane email={selectedEmail} onReply={handleReply} onForward={handleForward} onRefresh={refetch} />
          </div>
        )}
      </Card>

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={composeDefaults.to}
        defaultSubject={composeDefaults.subject}
        defaultBody={composeDefaults.body}
      />
    </div>
  );
}
