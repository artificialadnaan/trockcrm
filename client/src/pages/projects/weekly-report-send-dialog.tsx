import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import {
  weeklyReportGreeting,
  weeklyReportGreetingNameFor,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  fetchWeeklyReportSendDraft,
  sendWeeklyReport,
  type WeeklyReportSendDraft,
} from "@/hooks/use-weekly-reports";

// The send modal. It RENDERS a draft the server composed; it does not compose one.
//
// The subject, the greeting, the default message and the pre-filled recipients all arrive from
// GET /weekly-reports/reports/:id/send-draft, and the same three values go back to POST .../send. T-Rock
// Cam's modal will fetch the same draft and post the same mutation, which is what keeps the two surfaces
// from drifting into two different emails for the same feature.
//
// Native <select> is not used here (there is nothing to pick from a list), but the same rule that governs
// the rest of this page applies to anything added later: Base UI's <Select> needs an `items` prop or the
// trigger renders the raw value.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WeeklyReportSendDialog({
  reportId,
  onClose,
  onSent,
}: {
  reportId: string;
  onClose: () => void;
  /** Fired after a successful send so the caller can refresh the board it was opened from. */
  onSent: () => void;
}) {
  const [draft, setDraft] = useState<WeeklyReportSendDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attachPdf, setAttachPdf] = useState(true);
  const [pendingRecipient, setPendingRecipient] = useState("");
  const [sending, setSending] = useState(false);
  const [sentUrl, setSentUrl] = useState<string | null>(null);

  // RECOMPUTED, not rendered from the draft. The server picks the greeting from the recipients it is
  // FINALLY given (send-service.ts), while `draft.greeting` was computed from the PRE-FILLED list — so the
  // moment the PM removes the DOC and leaves the client's PM on, the two disagree and the modal shows
  // "Hello Jay," for an email that will read "Hello Melissa,". On a modal whose entire premise is that the
  // PM approves exactly what the client receives, that is the one line that must not be a guess. The rule
  // itself lives in shared, so this is the same function the server runs, not a second copy of it.
  const greeting = useMemo(
    () => weeklyReportGreeting(weeklyReportGreetingNameFor(draft?.recipientOptions ?? [], recipients)),
    [draft, recipients],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchWeeklyReportSendDraft(reportId);
        if (cancelled) return;
        setDraft(loaded);
        setRecipients(loaded.recipients);
        setSubject(loaded.subject);
        setMessage(loaded.contextParagraph);
        setAttachPdf(loaded.attachPdf);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Couldn't load the send draft");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  const addRecipient = (): boolean => {
    const candidate = pendingRecipient.trim();
    if (!candidate) return true;
    if (!EMAIL_PATTERN.test(candidate)) {
      toast.error("That doesn't look like an email address");
      return false;
    }
    if (!recipients.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
      setRecipients((prev) => [...prev, candidate]);
    }
    setPendingRecipient("");
    return true;
  };

  const onSend = async () => {
    // A typed-but-not-added address counts. Sending `recipients` alone would drop it silently and the
    // person the PM had just added would never receive the report — the same trap the settings dialog
    // documents, and it matters more here because the recipient is a client.
    const candidate = pendingRecipient.trim();
    let toSend = recipients;
    if (candidate) {
      if (!EMAIL_PATTERN.test(candidate)) {
        toast.error("That doesn't look like an email address");
        return;
      }
      if (!recipients.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
        toSend = [...recipients, candidate];
      }
    }
    if (toSend.length === 0) {
      toast.error("Add at least one recipient");
      return;
    }

    setSending(true);
    try {
      const result = await sendWeeklyReport(reportId, {
        recipients: toSend,
        subject,
        contextParagraph: message,
        attachPdf,
      });
      setRecipients(toSend);
      setPendingRecipient("");
      // The URL is shown rather than the dialog simply closing: this is the ONE moment the working link
      // exists in a form anyone can copy — only its hash is stored — so a PM who wants to paste it
      // somewhere has to be given the chance here.
      setSentUrl(result.shareUrl);
      toast.success("Report sent — the client's email is on its way");
      onSent();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send the report");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {draft?.isCorrection ? "Send correction to client" : "Send weekly report to client"}
          </DialogTitle>
        </DialogHeader>

        {loadError ? (
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-brand-red">
            <AlertTriangle className="h-4 w-4" /> {loadError}
          </p>
        ) : !draft ? (
          <div className="flex items-center gap-2 text-[13.5px] text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing the email…
          </div>
        ) : sentUrl ? (
          <SentPanel url={sentUrl} onClose={onClose} />
        ) : (
          <div className="space-y-4">
            {draft.isCorrection ? (
              <p className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[13px] font-semibold text-violet-700">
                Version {draft.version}. The client is told plainly that this replaces the copy they already
                have, and the earlier link starts showing a notice that a newer version was issued.
              </p>
            ) : (
              draft.version > 1 && (
                // A later version whose predecessor never reached the client. Saying "this replaces the
                // copy you already have" to somebody who never received one sends them looking for an
                // email that does not exist, so this goes out as a first copy and says so here.
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-800">
                  Version {draft.version}. The earlier version never reached the client, so this is sent as
                  their first copy — it does not say it replaces anything.
                </p>
              )
            )}

            <Field label="To">
              <ul className="space-y-1.5">
                {recipients.length === 0 && (
                  <li className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[13px] text-slate-400">
                    No recipients yet — add at least one client address.
                  </li>
                )}
                {recipients.map((email) => (
                  <li
                    key={email}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-[13.5px] text-slate-700"
                  >
                    <span>
                      {email}
                      {roleFor(draft, email) && (
                        <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                          {roleFor(draft, email)}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRecipients((prev) => prev.filter((entry) => entry !== email))}
                      aria-label={`Remove ${email}`}
                      className="rounded p-1 text-slate-400 hover:text-brand-red"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="email"
                  value={pendingRecipient}
                  onChange={(event) => setPendingRecipient(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRecipient();
                    }
                  }}
                  placeholder="name@client.com"
                  aria-label="Add a recipient"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] outline-none placeholder:text-slate-300 focus:border-brand-red/40"
                />
                <Button type="button" variant="outline" onClick={addRecipient}>
                  Add
                </Button>
              </div>
            </Field>

            <Field label="Subject">
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                aria-label="Subject"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] outline-none focus:border-brand-red/40"
              />
            </Field>

            <Field label="Message">
              <p className="mb-1.5 text-[13px] font-semibold text-slate-500">{greeting}</p>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={5}
                aria-label="Message"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] leading-relaxed outline-none focus:border-brand-red/40"
              />
              <p className="mt-1.5 text-[12px] text-slate-400">
                The link to the report and your name, email and phone are added below this automatically.
              </p>
            </Field>

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12.5px] text-slate-600">
              <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
                Signed as
              </p>
              {[draft.sender.name, draft.sender.email, draft.sender.phone].filter(Boolean).length === 0 ? (
                <p className="font-semibold text-amber-700">
                  This project has no T-Rock PM on file, so the client gets no name or number to reply to.
                  Set one on the project before sending.
                </p>
              ) : (
                <>
                  {draft.sender.name && <div className="font-semibold text-slate-800">{draft.sender.name}</div>}
                  {draft.sender.email && <div>{draft.sender.email}</div>}
                  {draft.sender.phone && <div>{draft.sender.phone}</div>}
                </>
              )}
            </div>

            <label className="flex items-center gap-2 text-[13.5px] font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={attachPdf}
                onChange={(event) => setAttachPdf(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-[#CC0000]"
              />
              Attach the report PDF
            </label>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <Button variant="outline" onClick={onClose} disabled={sending}>
                Cancel
              </Button>
              <Button onClick={onSend} disabled={sending}>
                {sending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                )}
                Send to client
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function roleFor(draft: WeeklyReportSendDraft, email: string): string | null {
  const match = draft.recipientOptions.find(
    (option) => option.email.toLowerCase() === email.toLowerCase(),
  );
  return match ? match.role : null;
}

/**
 * Shown after a successful send.
 *
 * The delivery itself is a queued job, so "sent" here means the report is committed and the email is on
 * its way — not that a mail server has accepted it. Saying so is the honest version, and the board's
 * "Send failed" chip is what reports the other outcome.
 */
function SentPanel({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13.5px] font-semibold text-emerald-800">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        The report is locked and the client email is queued. If it fails to send you&rsquo;ll see a
        &ldquo;Send failed&rdquo; chip on the board with a retry.
      </p>
      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Client link</p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={url}
            aria-label="Client link"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[12.5px] text-slate-600 outline-none"
          />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                toast.success("Link copied");
              } catch {
                // Clipboard access can be refused outright (permissions, insecure origin). The input is
                // readable and selectable either way, so say what happened rather than nothing.
                toast.error("Couldn't copy — select the link and copy it manually");
              }
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] text-slate-400">
          This link is shown once. It expires in 180 days and can be revoked from the report.
        </p>
      </div>
      <div className="flex justify-end border-t border-slate-200 pt-4">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      {children}
    </div>
  );
}
