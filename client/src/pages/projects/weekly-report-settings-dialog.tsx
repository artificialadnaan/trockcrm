import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { saveWeeklyReportSettings, useWeeklyReportSettings } from "@/hooks/use-weekly-reports";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who receives the due-day digest listing who has and hasn't filed.
 *
 * A list held as data rather than names in code, so changing the roster is an edit here rather than a
 * deploy. The API restricts writes to admin/director — a superintendent could otherwise remove
 * themselves from the report that tracks them.
 */
export function WeeklyReportSettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, loading, error } = useWeeklyReportSettings();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) setEmails(settings.leadershipRecipientEmails);
  }, [settings]);

  const addEmail = () => {
    const candidate = draft.trim().toLowerCase();
    if (!candidate) return;
    if (!EMAIL_PATTERN.test(candidate)) {
      toast.error("That doesn't look like an email address");
      return;
    }
    if (emails.includes(candidate)) {
      setDraft("");
      return;
    }
    setEmails((prev) => [...prev, candidate]);
    setDraft("");
  };

  const onSave = async () => {
    // A typed-but-not-added address counts. Saving `emails` alone discarded it, showed a success
    // toast and closed — so the user was told their recipient was saved while it was thrown away,
    // and the person they had just added would never receive the digest. A malformed draft is
    // reported rather than silently dropped for the same reason.
    const pending = draft.trim().toLowerCase();
    let toSave = emails;
    if (pending) {
      if (!EMAIL_PATTERN.test(pending)) {
        toast.error("That doesn't look like an email address");
        return;
      }
      if (!emails.includes(pending)) toSave = [...emails, pending];
    }

    setSaving(true);
    try {
      await saveWeeklyReportSettings(toSave);
      setEmails(toSave);
      setDraft("");
      toast.success("Settings saved");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Weekly report settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Leadership digest</p>
            <p className="mt-1 text-[13px] text-slate-500">
              On each project&rsquo;s due date these addresses receive one email listing which reports are done and
              which are outstanding.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-[13.5px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="text-[13.5px] font-semibold text-brand-red">{error}</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {emails.length === 0 && (
                  <li className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[13px] text-slate-400">
                    No recipients yet — the due-day digest won&rsquo;t be sent.
                  </li>
                )}
                {emails.map((email) => (
                  <li
                    key={email}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-[13.5px] text-slate-700"
                  >
                    {email}
                    <button
                      type="button"
                      onClick={() => setEmails((prev) => prev.filter((entry) => entry !== email))}
                      aria-label={`Remove ${email}`}
                      className="rounded p-1 text-slate-400 hover:text-brand-red"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEmail();
                    }
                  }}
                  placeholder="name@trockconstruction.com"
                  aria-label="Add a leadership recipient"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13.5px] outline-none placeholder:text-slate-300 focus:border-brand-red/40"
                />
                <Button type="button" variant="outline" onClick={addEmail}>
                  Add
                </Button>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={saving || loading}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
