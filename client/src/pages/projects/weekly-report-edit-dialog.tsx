import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS,
  WEEKLY_REPORT_SECTION_MAX_CHARS,
} from "@trock-crm/shared/types";
import {
  updateWeeklyReportContent,
  type WeeklyReportContentPatch,
  type WeeklyReportDetail,
} from "@/hooks/use-weekly-reports";

/**
 * Edit a week's contents from the CRM.
 *
 * `PATCH /reports/:id` has existed since 0222 and no CRM surface has ever called it — only T-Rock Cam.
 * So a director who spotted a typo in a draft had to send it back to the superintendent's phone, and a
 * report written by somebody who has since left the company had no editor at all.
 *
 * FIVE FIELDS, matching the endpoint exactly. Everything else on a report is written by an act rather
 * than typed: the status by a transition, the actor stamps by the write that made them, `remaining_weeks`
 * on submit, the frozen header on send. A form offering any of those would be offering to forge them.
 *
 * The validation below duplicates the server's, deliberately and knowingly. The server is the authority
 * and stays so — every rule here is also enforced there — but a 400 arriving after the request names no
 * field, so the user is told which of five inputs is wrong only if this checks first.
 */
export function WeeklyReportEditDialog({
  report,
  onClose,
  onSaved,
}: {
  report: WeeklyReportDetail;
  onClose: () => void;
  /** The saved report, so the row behind this dialog stops showing what it used to say. */
  onSaved: (updated: WeeklyReportDetail) => void;
}) {
  // ONE state object of STRINGS, including the two numeric fields. `<input type="number">` hands back a
  // string either way, and keeping the draft as typed is what lets "" mean "cleared" rather than 0 —
  // "nobody has said yet" and "zero percent complete" are different claims about a job, and both
  // renderers print them differently.
  const initial = {
    workCompleted: report.workCompleted ?? "",
    nextWeekLookAhead: report.nextWeekLookAhead ?? "",
    issuesConcerns: report.issuesConcerns ?? "",
    completionPercent: report.completionPercent == null ? "" : String(report.completionPercent),
    weatherDelayDays: report.weatherDelayDays == null ? "" : String(report.weatherDelayDays),
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  const handleChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Did the user actually touch this field, measured against what the dialog OPENED with.
   *
   * The snapshot behind this form comes from the History list and is as old as the tab. Sending every
   * field back means an untouched one carries that snapshot's value over whatever has happened since: a
   * superintendent edits the report from the phone, a director with this dialog open presses Save, and
   * the phone's work is silently replaced across every field the director never looked at. Nothing
   * refuses it — `updateWeeklyReportContent`'s concurrency predicate is on `status`, and the status did
   * not change — and nobody is told.
   *
   * The endpoint leaves an OMITTED key alone (see its `has(patch, …)` checks), so sending only what
   * changed is the whole fix, and it needs nothing from the server. The alternative, an `updated_at`
   * precondition, would refuse the director's save outright; that is a bigger change on both sides and
   * a worse outcome for the common case, where the two people edited different fields.
   */
  const changed = (field: keyof typeof form) => form[field] !== initial[field];

  const handleSubmit = async () => {
    const workCompleted = form.workCompleted.trim();
    // Judged only when they TOUCHED it. A section that was already empty is not this save's doing, and
    // refusing here would block a director from fixing the percentage on a draft the superintendent has
    // not written up yet. Blanking it deliberately is refused: the send gate re-checks this section at
    // every forward transition, so a report saved without it cannot be submitted, approved or sent.
    if (changed("workCompleted") && !workCompleted) {
      toast.error("Work completed can't be empty — it's what the report is for");
      return;
    }
    for (const [label, value] of [
      ["Work completed", workCompleted],
      ["Next week look-ahead", form.nextWeekLookAhead.trim()],
      ["Issues / concerns", form.issuesConcerns.trim()],
    ] as const) {
      if (value.length > WEEKLY_REPORT_SECTION_MAX_CHARS) {
        toast.error(`${label} is limited to ${WEEKLY_REPORT_SECTION_MAX_CHARS} characters`);
        return;
      }
    }

    const percentRaw = form.completionPercent.trim();
    let completionPercent: number | null = null;
    if (percentRaw) {
      const parsed = Number(percentRaw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        toast.error("Completion must be between 0 and 100");
        return;
      }
      // Two decimals, matching numeric(5,2) — rounded here so what the form shows next is what stored.
      completionPercent = Math.round(parsed * 100) / 100;
    }

    const delayRaw = form.weatherDelayDays.trim();
    let weatherDelayDays: number | null = null;
    if (delayRaw) {
      const parsed = Number(delayRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast.error("Weather delays must be a whole number of days");
        return;
      }
      // THE CEILING TOO, and named. The server refuses anything past this; without it here the user got
      // a request failure reported as "must be a whole number of days" — a rule they had not broken.
      if (parsed > WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS) {
        toast.error(`Weather delays are capped at ${WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS} days`);
        return;
      }
      weatherDelayDays = parsed;
    }

    // ONLY WHAT MOVED. An omitted key means "leave it alone" to the endpoint; a present one means
    // "make it this". Blank is ABSENT rather than empty for the three sections — the same rule both
    // renderers apply and the server's own normaliser — so clearing one sends null, not "".
    const patch: WeeklyReportContentPatch = {};
    if (changed("workCompleted")) patch.workCompleted = workCompleted;
    if (changed("nextWeekLookAhead")) patch.nextWeekLookAhead = form.nextWeekLookAhead.trim() || null;
    if (changed("issuesConcerns")) patch.issuesConcerns = form.issuesConcerns.trim() || null;
    if (changed("completionPercent")) patch.completionPercent = completionPercent;
    if (changed("weatherDelayDays")) patch.weatherDelayDays = weatherDelayDays;

    setSaving(true);
    try {
      const updated = await updateWeeklyReportContent(report.id, patch);
      toast.success("Report updated");
      onSaved(updated);
      onClose();
    } catch (error) {
      // Left OPEN on a failure. The server's refusals here are things the user can act on — a sent
      // report wants a correction, a concurrent edit wants a reload — and closing would take their work
      // with it.
      toast.error(error instanceof Error ? error.message : "Couldn't save this report");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:!max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-extrabold tracking-tight text-slate-950">
            Edit week of {fmtWeek(report.weekOf)}
            {report.version > 1 && (
              <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-violet-600">
                v{report.version}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3.5">
          <Field label="Work completed" hint="Required — the send gate checks it at every step">
            <Textarea
              aria-label="Work completed"
              rows={5}
              value={form.workCompleted}
              onChange={(event) => handleChange("workCompleted", event.target.value)}
            />
          </Field>
          <Field label="Next week look-ahead">
            <Textarea
              aria-label="Next week look-ahead"
              rows={3}
              value={form.nextWeekLookAhead}
              onChange={(event) => handleChange("nextWeekLookAhead", event.target.value)}
            />
          </Field>
          <Field label="Issues / concerns">
            <Textarea
              aria-label="Issues / concerns"
              rows={3}
              value={form.issuesConcerns}
              onChange={(event) => handleChange("issuesConcerns", event.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Completion %">
              <input
                aria-label="Completion percent"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.completionPercent}
                onChange={(event) => handleChange("completionPercent", event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] tabular-nums outline-none focus:border-brand-red/40"
              />
            </Field>
            <Field label="Weather delay days">
              <input
                aria-label="Weather delay days"
                type="number"
                min={0}
                max={WEEKLY_REPORT_MAX_WEATHER_DELAY_DAYS}
                step="1"
                value={form.weatherDelayDays}
                onChange={(event) => handleChange("weatherDelayDays", event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] tabular-nums outline-none focus:border-brand-red/40"
              />
            </Field>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `text-slate-500`, NOT the `text-slate-400` the neighbouring weekly-report dialogs use.
 *
 * slate-400 on white at this size measures 2.56:1 against WCAG's 4.5, and this app carries a ratchet that
 * fails the build when a new file adds one (see lib/muted-text-contrast.test.ts). The existing 400s are a
 * measured backlog the visual system owns; a new form does not get to join it for consistency's sake.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        {label}
        {hint && <span className="ml-1.5 font-semibold normal-case tracking-normal text-slate-500">{hint}</span>}
      </p>
      {children}
    </div>
  );
}

/** UTC, like every other rendering of `week_of` — it is a calendar date with no time in it. */
function fmtWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
