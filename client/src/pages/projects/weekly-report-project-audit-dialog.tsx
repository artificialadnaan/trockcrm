import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bell,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Loader2,
  Mail,
  PauseCircle,
  RefreshCw,
  Send,
  Siren,
  Eye,
  EyeOff,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  useWeeklyReportProjectAudit,
  type WeeklyReportAuditEvent,
  type WeeklyReportAuditReport,
  type WeeklyReportViewSession,
  type WeeklyReportProjectAudit,
} from "@/hooks/use-weekly-reports";

/**
 * THE RECORD OF ONE PROJECT'S REPORTING.
 *
 * Every fact shown here was already being written and none of it was reachable: the Projects tab offered
 * a row with an Edit button, so "when did the client actually get week 8, and who approved it" was a
 * question only answerable with SQL.
 *
 * The events are NOT assembled here — the server builds and orders them, because the ordering and the
 * wording are the substance of an audit trail and a second implementation in the browser is a second set
 * of answers. This file decides only how they look.
 */

const EVENT_ICON: Record<WeeklyReportAuditEvent["type"], typeof Check> = {
  drafted: FileText,
  submitted: Send,
  approved: Check,
  sent: Mail,
  accepted: CheckCheck,
  delivered: CheckCheck,
  delayed: Clock,
  failed: AlertTriangle,
  retried: RefreshCw,
  alerted: Siren,
  superseded: Ban,
};

const EVENT_LABEL: Record<WeeklyReportAuditEvent["type"], string> = {
  drafted: "Drafted",
  submitted: "Submitted for review",
  approved: "Approved",
  sent: "Sent",
  accepted: "Accepted by the mail provider",
  delivered: "Delivered",
  delayed: "Still in transit",
  failed: "Delivery failed",
  retried: "Retried",
  alerted: "Stalled — leadership alerted",
  superseded: "Superseded by a correction",
};

/** Only the two failure tones get colour. Everything else is a normal step and stays neutral. */
const EVENT_TONE: Partial<Record<WeeklyReportAuditEvent["type"], string>> = {
  failed: "text-brand-red",
  delayed: "text-amber-600",
  alerted: "text-amber-600",
  superseded: "text-slate-400",
};

function fmtWeek(iso: string): string {
  // week_of is a plain calendar date; parsing it at UTC keeps it off the previous day west of Greenwich.
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function WeeklyReportProjectAuditDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { audit, loading, error } = useWeeklyReportProjectAudit(projectId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:!max-w-4xl">
        <DialogHeader className="border-b border-slate-200 px-6 py-4">
          <DialogTitle className="text-[16px] font-extrabold tracking-tight text-slate-950">
            {audit
              ? (audit.project.propertyDisplayName ?? audit.project.dealName ?? "Weekly report history")
              : "Weekly report history"}
          </DialogTitle>
          <p className="mt-0.5 text-[13.5px] text-slate-500">
            {audit ? <ProjectSubtitle audit={audit} /> : "Every report on this project and what happened to it."}
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <p className="flex items-center gap-2 text-[13.5px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading this project's history…
            </p>
          )}
          {error && (
            <p className="flex items-center gap-2 text-[13.5px] font-semibold text-brand-red">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </p>
          )}
          {audit && !loading && <AuditBody audit={audit} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSubtitle({ audit }: { audit: WeeklyReportProjectAudit }) {
  const { project } = audit;
  const parts = [
    project.projectNumber,
    project.clientName,
    `PM · ${project.trockPmName ?? "Unassigned"}`,
    `Super · ${project.trockSuperName ?? "Unassigned"}`,
  ].filter(Boolean);
  return <>{parts.join("  ·  ")}</>;
}

function AuditBody({ audit }: { audit: WeeklyReportProjectAudit }) {
  // `outstanding` is the SERVER's verdict, not a rule re-derived here — see project-audit-service.
  // This count, the chip on the card and the card's border are three renderings of one fact, and while
  // each owned its own predicate they disagreed twice on this PR. Reading one boolean is what stops a
  // third disagreement being expressible.
  const outstanding = useMemo(() => audit.reports.filter((r) => r.outstanding).length, [audit.reports]);
  const sent = useMemo(
    () => audit.reports.filter((r) => r.status === "sent" && !r.supersededById).length,
    [audit.reports],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Reports sent" value={String(sent)} />
        <Stat
          label="Not delivered"
          value={String(outstanding)}
          tone={outstanding > 0 ? "alert" : undefined}
        />
        <Stat label="Weeks on record" value={String(new Set(audit.reports.map((r) => r.weekOf)).size)} />
      </div>

      {audit.reports.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-[13.5px] text-slate-500">
          No reports have been filed on this project yet.
        </p>
      ) : (
        <section className="space-y-3">
          <h3 className="text-[13.5px] font-bold tracking-tight text-slate-900">Reports</h3>
          <div className="space-y-2.5">
            {audit.reports.map((report) => (
              <ReportCard key={report.id} report={report} trackingSince={audit.viewTrackingSince} />
            ))}
          </div>
        </section>
      )}

      {audit.pauses.length > 0 && (
        <Ledger title="Reporting paused" icon={PauseCircle}>
          {audit.pauses.map((pause, index) => (
            <LedgerRow
              key={`${pause.pausedFrom}-${index}`}
              primary={
                pause.resumedOn
                  ? `${fmtWeek(pause.pausedFrom)} → ${fmtWeek(pause.resumedOn)}`
                  : `${fmtWeek(pause.pausedFrom)} → still paused`
              }
              secondary={[
                pause.pausedByName ? `Paused by ${pause.pausedByName}` : null,
                pause.resumedByName ? `resumed by ${pause.resumedByName}` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            />
          ))}
        </Ledger>
      )}

      {audit.dismissals.length > 0 && (
        <Ledger title="Weeks written off" icon={Ban}>
          {audit.dismissals.map((dismissal, index) => (
            <LedgerRow
              key={`${dismissal.weekOf}-${index}`}
              primary={`Week of ${fmtWeek(dismissal.weekOf)}`}
              secondary={[
                dismissal.reason,
                dismissal.actorName ? `by ${dismissal.actorName}` : null,
                fmtStamp(dismissal.at),
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Ledger>
      )}

      {audit.reminders.length > 0 && <ReminderLedger audit={audit} />}
    </div>
  );
}

/**
 * The reminder ledger is the longest and the least interesting of the three — one row per nudge, several
 * per week — so it is collapsed by default rather than pushing the reports off the screen.
 */
function ReminderLedger({ audit }: { audit: WeeklyReportProjectAudit }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2 text-[13.5px] font-bold tracking-tight text-slate-900 hover:text-brand-red"
      >
        <Bell className="h-4 w-4 text-slate-400" />
        Reminders sent
        <span className="text-[11.5px] font-semibold text-slate-500">
          ({audit.reminders.length}) {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {audit.reminders.map((reminder, index) => (
            <LedgerRow
              key={`${reminder.weekOf}-${reminder.kind}-${index}`}
              primary={`Week of ${fmtWeek(reminder.weekOf)}`}
              secondary={`${reminder.kind} · ${fmtStamp(reminder.at)}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReportCard({
  report,
  trackingSince,
}: {
  report: WeeklyReportAuditReport;
  /** The log's own horizon, passed through so ViewLog can tell silence from an absent record. */
  trackingSince: string | null;
}) {
  const superseded = Boolean(report.supersededById);
  // Two shades of outstanding, and the difference is what the CRM actually knows.
  //
  //   RED — something demonstrably went wrong: it bounced, it stalled, it was never accepted.
  //   AMBER — nothing has gone wrong with THIS version, but the one it replaced failed and no
  //           confirmation has come back yet, so the week is unresolved rather than broken.
  //
  // Amber is already this page's "watch it" tone (`delayed`, `alerted`), so the correction in flight
  // after a bounce reads as what it is, instead of borrowing the red of the bounce it is fixing.
  const failing = report.outstanding && report.undelivered;
  const unconfirmed = report.outstanding && !report.undelivered;
  return (
    <article
      // Keyed on the SERVER's `outstanding`, same as the chip below and the count above — see the note
      // in AuditBody. Keying this on `undelivered` alone left a resolved week wearing the red of an
      // outstanding failure while the other two surfaces called it settled.
      className={`rounded-lg border px-4 py-3 ${
        failing
          ? "border-brand-red/30 bg-brand-red/[0.03]"
          : unconfirmed
            ? "border-amber-300/60 bg-amber-50/40"
            : "border-slate-200 bg-white"
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className="text-[13.5px] font-bold text-slate-950">Week of {fmtWeek(report.weekOf)}</h4>
        {report.version > 1 && (
          <span className="text-[11.5px] font-semibold text-slate-500">Version {report.version}</span>
        )}
        {superseded && (
          <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-semibold text-slate-500">
            Superseded
          </span>
        )}
        {failing && (
          <span className="rounded border border-brand-red/30 bg-brand-red/5 px-1.5 py-px text-[11px] font-semibold text-brand-red">
            {report.deliveryStatus ?? "Not delivered"}
          </span>
        )}
        {unconfirmed && (
          // Deliberately not "Not delivered": the provider took this one and has said nothing since.
          // Claiming a failure the CRM cannot evidence is the mirror of the bug above it.
          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-px text-[11px] font-semibold text-amber-700">
            Not confirmed
          </span>
        )}
      </header>

      <ViewLog report={report} trackingSince={trackingSince} />

      {report.events.length === 0 ? (
        <p className="mt-2 text-[11.5px] text-slate-500">Nothing has happened to this one yet.</p>
      ) : (
        <ol className="mt-2.5 space-y-1.5">
          {report.events.map((event, index) => {
            const Icon = EVENT_ICON[event.type];
            return (
              <li key={`${event.type}-${event.at}-${index}`} className="flex items-start gap-2.5">
                <Icon className={`mt-[3px] h-3.5 w-3.5 shrink-0 ${EVENT_TONE[event.type] ?? "text-slate-400"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] text-slate-800">
                    <span className="font-semibold">{EVENT_LABEL[event.type]}</span>
                    {event.actorName && <span className="text-slate-600"> by {event.actorName}</span>}
                    <span className="text-slate-500"> · {fmtStamp(event.at)}</span>
                  </p>
                  {event.detail && (
                    <p className="mt-px break-words text-[11.5px] text-slate-500">{event.detail}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "alert" }) {
  return (
    <div
      className={`rounded-lg border px-3.5 py-2.5 ${
        tone === "alert" ? "border-brand-red/30 bg-brand-red/[0.03]" : "border-slate-200 bg-white"
      }`}
    >
      <div
        // 24px is DESIGN.md's `headline` step, and "heavy executive typography for major metrics" is
        // what the system asks for here. The 20px I reached for first was a step this product does not
        // have.
        className={`text-2xl font-extrabold tabular-nums ${
          tone === "alert" ? "text-brand-red" : "text-slate-950"
        }`}
      >
        {value}
      </div>
      <div className="text-[11.5px] font-semibold text-slate-500">{label}</div>
    </div>
  );
}

function Ledger({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Check;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-[13.5px] font-bold tracking-tight text-slate-900">
        <Icon className="h-4 w-4 text-slate-400" />
        {title}
      </h3>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">{children}</div>
    </section>
  );
}

function LedgerRow({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <div className="px-3.5 py-2">
      <p className="text-[13.5px] text-slate-800">{primary}</p>
      {secondary && <p className="text-[11.5px] text-slate-500">{secondary}</p>}
    </div>
  );
}

/**
 * WHO OPENED IT — the half of the record a client dispute actually turns on.
 *
 * Shown with the judgement AND the raw detail, never the judgement alone. A client's mail security
 * fetches the link within seconds of delivery, so "opened 5 times" is mostly robots; but the reader of
 * this page may be about to repeat what it says to that client, and they need to be able to see the
 * address, the browser and the timing for themselves rather than take our word for it.
 */
function ViewLog({
  report,
  trackingSince,
}: {
  report: WeeklyReportAuditReport;
  trackingSince: string | null;
}) {
  const [open, setOpen] = useState(false);
  const sessions = report.viewSessions ?? [];

  // A report that was never SENT has nothing to have been opened, and saying "not opened" about it
  // would read as a failure rather than as a stage it has not reached.
  if (report.status !== "sent") return null;

  // NOTHING RECORDED IS NOT THE SAME CLAIM AS NOBODY OPENED IT, and an empty list looks identical
  // either way. Reports sent before the log existed have no rows, and neither do reports old enough for
  // the retention sweep to have removed theirs. Rendering that as "Nobody has opened the link yet" is
  // the CRM asserting a fact about the client's behaviour out of a gap in its own records — on the one
  // screen built to be quoted back to that client. Caught by Codex.
  // PARSED, not string-compared. Both values are ISO today, but the API returns whatever the driver
  // hands back and PostgreSQL's own text form is `2026-06-01 00:00:00+00` — a space where the `T` goes,
  // which sorts BEFORE every ISO string and would silently mark every week as untracked.
  const sentMs = report.sentAt ? Date.parse(report.sentAt) : Number.NaN;
  const sinceMs = trackingSince ? Date.parse(trackingSince) : Number.NaN;
  const outsideTracking =
    sessions.length === 0 && Number.isFinite(sentMs) && Number.isFinite(sinceMs) && sentMs < sinceMs;

  if (outsideTracking) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-slate-500">
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
        No open tracking was kept for this week — sent before the log began, or past its retention.
      </p>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-slate-500">
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
        Nobody has opened the link yet.
      </p>
    );
  }

  const fetches = sessions.reduce(
    (total, session) => total + session.pageViews + session.photoViews + session.pdfDownloads,
    0,
  );

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-700 hover:text-brand-red"
      >
        <Eye className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        {/* A COUNT, NOT A VERDICT.
            This line used to say whether a person had read the report. It no longer does, and the
            deletion is the point rather than a simplification: every rule that separated a reader from
            a link scanner had a counterexample, review found them one after another, and a wrong guess
            here is quoted to a client. See shared/lib/weeklyReportViews.
            What is left is countable and cannot be refuted — this many fetches, in this many sittings,
            with the address, device and timing of each one underneath. The reader decides. */}
        {sessions.length === 1
          ? `${fetches} ${fetches === 1 ? "fetch" : "fetches"} of this link, in one sitting`
          : `${fetches} fetches of this link, across ${sessions.length} sittings`}
        <span className="font-normal text-slate-500">({open ? "hide" : "show"} detail)</span>
      </button>

      {/* OUTSIDE the expander. A qualification that only appears once somebody thinks to open the detail
          is not a qualification — the headline above is what gets read, and quoted, and it is the line
          that would otherwise be taken as a complete count. */}
      {report.viewSessionsTruncated && (
        <p className="mt-1.5 text-[11px] font-semibold text-amber-700">
          This link was fetched more times than the page shows. Photo and PDF fetches are kept ahead of
          plain page requests, and the earliest of each are shown.
        </p>
      )}

      {open && (
        <ol className="mt-1.5 space-y-1.5 border-l-2 border-slate-200 pl-3">
          {sessions.map((session, index) => (
            <ViewSessionRow key={`${session.startedAt}-${index}`} session={session} />
          ))}
        </ol>
      )}
    </div>
  );
}


function ViewSessionRow({ session }: { session: WeeklyReportViewSession }) {
  const fetched = [
    session.pageViews > 0 ? `opened the page${session.pageViews > 1 ? ` ${session.pageViews}×` : ""}` : null,
    session.photoViews > 0 ? `${session.photoViews} photo${session.photoViews === 1 ? "" : "s"}` : null,
    session.pdfDownloads > 0 ? "downloaded the PDF" : null,
  ].filter(Boolean);

  const spanMinutes = Math.round(
    (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000,
  );

  return (
    <li className="text-[11.5px]">
      {/* FACTS ONLY, in the order somebody reads them out: when, for how long, what they took. There
          was a label here — "A person", "Email scanner" — and it is gone on purpose; see the headline
          above and shared/lib/weeklyReportViews. */}
      <p className="text-slate-800">
        <span className="font-semibold">{fmtStamp(session.startedAt)}</span>
        {spanMinutes >= 1 && <span className="text-slate-500"> · over {spanMinutes} min</span>}
        {fetched.length > 0 && <span className="text-slate-600"> · {fetched.join(", ")}</span>}
      </p>
      <p className="text-slate-500">
        {session.ip ?? "address not recorded"}
        {session.userAgent ? ` · ${session.userAgent.slice(0, 90)}` : " · no browser reported"}
      </p>
    </li>
  );
}
