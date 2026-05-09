import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DOMPurify from "dompurify";
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
import { EmailAssignmentQueue } from "@/components/email/email-assignment-queue";
import { EmailComposeDialog } from "@/components/email/email-compose-dialog";
import { EmailThreadView } from "@/components/email/email-thread-view";
import { useGraphAuth } from "@/hooks/use-graph-auth";
import { useUserEmails, type Email } from "@/hooks/use-emails";
import { cn } from "@/lib/utils";

type EmailFilter = "all" | "unread" | "unassigned" | "sent";

const FILTERS: Array<{
  key: EmailFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { key: "all", label: "All", icon: Inbox },
  { key: "unread", label: "Unread", icon: Mail },
  { key: "unassigned", label: "Unassigned", icon: AlertTriangle },
  { key: "sent", label: "Sent", icon: Send },
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
  return Boolean(email.dealId || email.contactId);
}

function needsAttention(email: Email) {
  return email.direction === "inbound" && !isLinked(email);
}

function matchesFilter(email: Email, filter: EmailFilter) {
  if (filter === "sent") return email.direction === "outbound";
  if (filter === "unassigned") return needsAttention(email);
  if (filter === "unread") return needsAttention(email);
  return true;
}

function countForFilter(emails: Email[], filter: EmailFilter) {
  return emails.filter((email) => matchesFilter(email, filter)).length;
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
}: {
  email: Email | null;
  onReply: (email: Email) => void;
}) {
  const [showThreadTools, setShowThreadTools] = useState(false);

  useEffect(() => {
    setShowThreadTools(false);
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

  const fromMe = email.direction === "outbound";
  const recipientLine = fromMe ? `to ${email.toAddresses.join(", ") || "recipient"}` : `from ${email.fromAddress}`;

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
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Star">
              <Star className="h-4 w-4" />
            </button>
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Archive">
              <Archive className="h-4 w-4" />
            </button>
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Delete">
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
        <Button variant="outline" size="sm">
          <Forward className="mr-1 h-4 w-4" />
          Forward
        </Button>
        {email.graphConversationId ? (
          <Button variant="outline" size="sm" onClick={() => setShowThreadTools((value) => !value)}>
            <Link2 className="mr-1 h-4 w-4" />
            Thread tools
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function EmailInboxPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EmailFilter>("all");
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { connected, loading: graphLoading, startConsent } = useGraphAuth();
  const oauthConnected = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  const direction = filter === "sent" ? "outbound" : undefined;
  const { emails, pagination, loading, error, refetch } = useUserEmails({
    direction,
    search: search.length >= 2 ? search : undefined,
    page,
    limit: 25,
  });

  const visibleEmails = useMemo(() => emails.filter((email) => matchesFilter(email, filter)), [emails, filter]);
  const selectedEmail = emails.find((email) => email.id === selectedId) ?? visibleEmails[0] ?? null;

  const counts = useMemo(
    () => ({
      all: emails.length,
      unread: countForFilter(emails, "unread"),
      unassigned: countForFilter(emails, "unassigned"),
      sent: countForFilter(emails, "sent"),
      linked: emails.filter(isLinked).length,
      today: emails.filter((email) => {
        const date = new Date(email.sentAt);
        return !Number.isNaN(date.getTime()) && Date.now() - date.getTime() < 24 * 60 * 60 * 1000;
      }).length,
    }),
    [emails]
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
    setReplyTo(email.direction === "inbound" ? email.fromAddress : email.toAddresses[0]);
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
          <Button variant="outline" size="lg" onClick={startConsent} disabled={connected || graphLoading}>
            <Mail className="mr-1.5 h-4 w-4" />
            {connected ? "Connected" : "Microsoft 365"}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setReplyTo(undefined);
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

      <GraphAuthBanner />

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
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
            {FILTERS.map((item) => {
              const Icon = item.icon;
              const isActive = filter === item.key;
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
                    {counts[item.key]}
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

          <EmailReaderPane email={selectedEmail} onReply={handleReply} />
        </div>
      </Card>

      <EmailAssignmentQueue />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={replyTo}
      />
    </div>
  );
}
