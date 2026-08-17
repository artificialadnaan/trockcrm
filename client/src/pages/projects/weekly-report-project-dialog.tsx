import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDeals } from "@/hooks/use-deals";
import {
  createWeeklyReportProject,
  deleteWeeklyReportProject,
  updateWeeklyReportProject,
  useWeeklyReportAssignableUsers,
  type WeeklyReportProject,
  type WeeklyReportProjectPayload,
} from "@/hooks/use-weekly-reports";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const CLIENT_ROLES = [
  { key: "doc", label: "DOC" },
  { key: "pm", label: "PM" },
  { key: "rm", label: "RM" },
  { key: "cm", label: "CM" },
] as const;

type ClientRole = (typeof CLIENT_ROLES)[number]["key"];

interface FormState {
  dealId: string;
  dealLabel: string;
  propertyDisplayName: string;
  clientName: string;
  clientTeam: Record<ClientRole, { name: string; email: string }>;
  trockPmUserId: string;
  trockSuperUserId: string;
  contractDate: string;
  contractDateNote: string;
  projectStartDate: string;
  projectStartDateNote: string;
  projectCompletionDate: string;
  projectCompletionDateNote: string;
  projectedDurationWeeks: string;
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate: string;
  status: "active" | "paused" | "completed";
}

function todayIso(): string {
  // The office's business day, not the browser's — the cadence is anchored in Central.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function emptyForm(): FormState {
  return {
    dealId: "",
    dealLabel: "",
    propertyDisplayName: "",
    clientName: "",
    clientTeam: {
      doc: { name: "", email: "" },
      pm: { name: "", email: "" },
      rm: { name: "", email: "" },
      cm: { name: "", email: "" },
    },
    trockPmUserId: "",
    trockSuperUserId: "",
    contractDate: "",
    contractDateNote: "",
    projectStartDate: "",
    projectStartDateNote: "",
    projectCompletionDate: "",
    projectCompletionDateNote: "",
    projectedDurationWeeks: "",
    cadenceWeekday: 4,
    cadenceStartDate: todayIso(),
    cadenceEndDate: "",
    status: "active",
  };
}

function formFromProject(project: WeeklyReportProject): FormState {
  return {
    dealId: project.dealId,
    dealLabel: [project.projectNumber, project.dealName].filter(Boolean).join(" · "),
    propertyDisplayName: project.propertyDisplayName ?? "",
    clientName: project.clientName ?? "",
    clientTeam: {
      doc: { name: project.clientTeam.doc.name ?? "", email: project.clientTeam.doc.email ?? "" },
      pm: { name: project.clientTeam.pm.name ?? "", email: project.clientTeam.pm.email ?? "" },
      rm: { name: project.clientTeam.rm.name ?? "", email: project.clientTeam.rm.email ?? "" },
      cm: { name: project.clientTeam.cm.name ?? "", email: project.clientTeam.cm.email ?? "" },
    },
    trockPmUserId: project.trockPmUserId ?? "",
    trockSuperUserId: project.trockSuperUserId ?? "",
    contractDate: project.contractDate ?? "",
    contractDateNote: project.contractDateNote ?? "",
    projectStartDate: project.projectStartDate ?? "",
    projectStartDateNote: project.projectStartDateNote ?? "",
    projectCompletionDate: project.projectCompletionDate ?? "",
    projectCompletionDateNote: project.projectCompletionDateNote ?? "",
    projectedDurationWeeks: project.projectedDurationWeeks == null ? "" : String(project.projectedDurationWeeks),
    cadenceWeekday: project.cadenceWeekday,
    cadenceStartDate: project.cadenceStartDate,
    cadenceEndDate: project.cadenceEndDate ?? "",
    status: project.status,
  };
}

/**
 * Build the API payload.
 *
 * Empty strings become `null`, never `undefined` — the server treats an omitted key as "leave alone" and
 * an explicit null as "clear it", so sending `undefined` would make it impossible to blank a field once
 * it had been set.
 */
function toPayload(form: FormState, includeDeal: boolean): WeeklyReportProjectPayload {
  const nullable = (value: string) => (value.trim() ? value.trim() : null);
  return {
    ...(includeDeal ? { dealId: form.dealId } : {}),
    propertyDisplayName: nullable(form.propertyDisplayName),
    clientName: nullable(form.clientName),
    clientTeam: {
      doc: { name: nullable(form.clientTeam.doc.name), email: nullable(form.clientTeam.doc.email) },
      pm: { name: nullable(form.clientTeam.pm.name), email: nullable(form.clientTeam.pm.email) },
      rm: { name: nullable(form.clientTeam.rm.name), email: nullable(form.clientTeam.rm.email) },
      cm: { name: nullable(form.clientTeam.cm.name), email: nullable(form.clientTeam.cm.email) },
    },
    trockPmUserId: nullable(form.trockPmUserId),
    trockSuperUserId: nullable(form.trockSuperUserId),
    contractDate: nullable(form.contractDate),
    contractDateNote: nullable(form.contractDateNote),
    projectStartDate: nullable(form.projectStartDate),
    projectStartDateNote: nullable(form.projectStartDateNote),
    projectCompletionDate: nullable(form.projectCompletionDate),
    projectCompletionDateNote: nullable(form.projectCompletionDateNote),
    projectedDurationWeeks: form.projectedDurationWeeks.trim() ? Number(form.projectedDurationWeeks) : null,
    cadenceWeekday: form.cadenceWeekday,
    cadenceStartDate: form.cadenceStartDate,
    cadenceEndDate: nullable(form.cadenceEndDate),
    status: form.status,
  };
}

export function WeeklyReportProjectDialog({
  project,
  existingDealIds = [],
  onClose,
  onSaved,
}: {
  project: WeeklyReportProject | null;
  /** Deals that already have a live setup. Offering one leads to a 409 after the form is filled in. */
  existingDealIds?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => (project ? formFromProject(project) : emptyForm()));
  const [saving, setSaving] = useState(false);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setContact = (role: ClientRole, field: "name" | "email", value: string) =>
    setForm((prev) => ({
      ...prev,
      clientTeam: { ...prev.clientTeam, [role]: { ...prev.clientTeam[role], [field]: value } },
    }));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project && !form.dealId) {
      toast.error("Pick the project this report belongs to");
      return;
    }
    setSaving(true);
    try {
      if (project) {
        await updateWeeklyReportProject(project.id, toPayload(form, false));
        toast.success("Weekly report project updated");
      } else {
        await createWeeklyReportProject(toPayload(form, true));
        toast.success("Weekly report project created");
      }
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that project");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!project) return;
    if (!window.confirm("Stop weekly reporting for this project? Reports already sent stay available.")) return;
    setSaving(true);
    try {
      await deleteWeeklyReportProject(project.id);
      toast.success("Weekly reporting stopped");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that project");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{project ? "Edit weekly report project" : "New weekly report project"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5">
          {project ? (
            <Field label="Project">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13.5px] font-semibold text-slate-700">
                {form.dealLabel || form.propertyDisplayName || "—"}
              </div>
            </Field>
          ) : (
            <DealPicker
              value={form.dealId}
              label={form.dealLabel}
              excludeDealIds={existingDealIds}
              onPick={(deal) =>
                setForm((prev) => ({
                  ...prev,
                  dealId: deal.id,
                  dealLabel: deal.label,
                  // Seed the display name from the deal so the common case needs no typing, while
                  // staying independently editable — the report header is the property, not the deal.
                  propertyDisplayName: prev.propertyDisplayName || deal.name,
                }))
              }
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Property name (as it prints)">
              <TextInput
                value={form.propertyDisplayName}
                onChange={(value) => setField("propertyDisplayName", value)}
                placeholder="4123 Cedar Springs"
              />
            </Field>
            <Field label="Client">
              <TextInput
                value={form.clientName}
                onChange={(value) => setField("clientName", value)}
                placeholder="Mack Real Estate Group"
              />
            </Field>
          </div>

          <Fieldset legend="Client team">
            <div className="space-y-2">
              {CLIENT_ROLES.map((role) => (
                <div key={role.key} className="grid gap-2 sm:grid-cols-[64px_1fr_1fr] sm:items-center">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{role.label}</span>
                  <TextInput
                    value={form.clientTeam[role.key].name}
                    onChange={(value) => setContact(role.key, "name", value)}
                    placeholder="Name"
                    ariaLabel={`${role.label} name`}
                  />
                  <TextInput
                    type="email"
                    value={form.clientTeam[role.key].email}
                    onChange={(value) => setContact(role.key, "email", value)}
                    placeholder="Email (optional)"
                    ariaLabel={`${role.label} email`}
                  />
                </div>
              ))}
            </div>
          </Fieldset>

          <Fieldset legend="T-Rock project team">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project manager">
                <FieldUserSelect
                  value={form.trockPmUserId}
                  onChange={(value) => setField("trockPmUserId", value)}
                  ariaLabel="T-Rock project manager"
                />
              </Field>
              <Field label="Superintendent">
                <FieldUserSelect
                  value={form.trockSuperUserId}
                  onChange={(value) => setField("trockSuperUserId", value)}
                  ariaLabel="T-Rock superintendent"
                />
              </Field>
            </div>
            <p className="mt-2 text-[11.5px] font-semibold text-slate-400">
              These two decide who can author, who must approve, and who gets the reminder emails.
            </p>
          </Fieldset>

          <Fieldset legend="Schedule">
            <div className="space-y-3">
              <DateWithNote
                label="Contract date"
                date={form.contractDate}
                note={form.contractDateNote}
                onDate={(value) => setField("contractDate", value)}
                onNote={(value) => setField("contractDateNote", value)}
              />
              <DateWithNote
                label="Project start"
                date={form.projectStartDate}
                note={form.projectStartDateNote}
                onDate={(value) => setField("projectStartDate", value)}
                onNote={(value) => setField("projectStartDateNote", value)}
              />
              <DateWithNote
                label="Project completion"
                date={form.projectCompletionDate}
                note={form.projectCompletionDateNote}
                onDate={(value) => setField("projectCompletionDate", value)}
                onNote={(value) => setField("projectCompletionDateNote", value)}
              />
              <Field label="Projected duration (weeks)">
                <TextInput
                  type="number"
                  value={form.projectedDurationWeeks}
                  onChange={(value) => setField("projectedDurationWeeks", value)}
                  placeholder="19"
                />
              </Field>
            </div>
            <p className="mt-2 text-[11.5px] font-semibold text-slate-400">
              A note prints in place of the date when the date isn’t known yet — e.g. “TBD Permit”.
            </p>
          </Fieldset>

          <Fieldset legend="Reporting cadence">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Due every">
                <select
                  value={form.cadenceWeekday}
                  onChange={(event) => setField("cadenceWeekday", Number(event.target.value))}
                  aria-label="Report due day"
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13.5px] font-semibold text-slate-700"
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day.value} value={day.value}>
                      {day.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reporting starts">
                <TextInput
                  type="date"
                  value={form.cadenceStartDate}
                  onChange={(value) => setField("cadenceStartDate", value)}
                />
              </Field>
              <Field label="Reporting ends (optional)">
                <TextInput
                  type="date"
                  value={form.cadenceEndDate}
                  onChange={(value) => setField("cadenceEndDate", value)}
                />
              </Field>
            </div>
            {project && (
              <div className="mt-3">
                <Field label="Status">
                  <select
                    value={form.status}
                    onChange={(event) => setField("status", event.target.value as FormState["status"])}
                    aria-label="Reporting status"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13.5px] font-semibold text-slate-700"
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                  </select>
                </Field>
                <p className="mt-1.5 text-[11.5px] font-semibold text-slate-400">
                  Paused and completed projects stop generating weeks and stop sending reminders.
                </p>
              </div>
            )}
          </Fieldset>

          <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
            {project && (
              <Button type="button" variant="ghost" onClick={onDelete} disabled={saving}>
                Stop reporting
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {project ? "Save changes" : "Create project"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-slate-200 p-4">
      <legend className="px-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">{legend}</legend>
      {children}
    </fieldset>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13.5px] text-slate-800 outline-none placeholder:text-slate-300 focus:border-brand-red/40"
    />
  );
}

function DateWithNote({
  label,
  date,
  note,
  onDate,
  onNote,
}: {
  label: string;
  date: string;
  note: string;
  onDate: (value: string) => void;
  onNote: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[150px_1fr_1fr] sm:items-center">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <TextInput type="date" value={date} onChange={onDate} ariaLabel={`${label} date`} />
      <TextInput value={note} onChange={onNote} placeholder="or a note, e.g. TBD Permit" ariaLabel={`${label} note`} />
    </div>
  );
}

/**
 * Deal picker.
 *
 * `scope: "all"` is REQUIRED. `GET /deals` silently defaults to `scope=mine`, which has already shipped
 * as a bug in two other pickers — a director setting up a superintendent's project would simply not find
 * it in the list.
 */
function DealPicker({
  value,
  label,
  excludeDealIds,
  onPick,
}: {
  value: string;
  label: string;
  excludeDealIds: string[];
  onPick: (deal: { id: string; name: string; label: string }) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { deals, loading } = useDeals(
    { search: debounced, scope: "all", limit: 20, isActive: true },
    { enabled: debounced.length >= 2 },
  );

  // A deal that already has a live setup cannot get a second one — the server answers 409 on the
  // unique index. Offering it anyway lets someone pick it, fill in the whole form, and only then be
  // told no. Filtered here rather than server-side because /deals is a general endpoint this feature
  // does not own.
  const selectable = useMemo(() => {
    const taken = new Set(excludeDealIds);
    return deals.filter((deal) => !taken.has(deal.id));
  }, [deals, excludeDealIds]);

  if (value) {
    return (
      <Field label="Project">
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13.5px] font-semibold text-slate-700">
            {label}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onPick({ id: "", name: "", label: "" })}>
            Change
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field label="Project">
      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(true);
            }}
            placeholder="Search by project name or number"
            aria-label="Search for a project"
            className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-slate-300"
          />
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        </div>
        {open && debounced.length >= 2 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
            {selectable.length === 0 && !loading ? (
              <p className="px-3 py-2.5 text-[13px] font-semibold text-slate-400">
                {deals.length > 0 ? "Those projects already have a weekly report setup" : "No matching projects"}
              </p>
            ) : (
              selectable.map((deal) => (
                <button
                  key={deal.id}
                  type="button"
                  onClick={() => {
                    onPick({
                      id: deal.id,
                      name: deal.name,
                      label: [deal.projectNumber ?? deal.dealNumber, deal.name].filter(Boolean).join(" · "),
                    });
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-[13.5px] hover:bg-slate-50"
                >
                  <span className="font-semibold text-slate-900">{deal.name}</span>
                  <span className="ml-2 text-[11.5px] font-semibold text-slate-400">
                    {deal.projectNumber ?? deal.dealNumber}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

/**
 * PM / superintendent picker.
 *
 * Sourced from the people feed rather than `deal_team_members`, which is empty in production — a picker
 * fed from it would offer nobody at all.
 */
function FieldUserSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const { users, loading } = useWeeklyReportAssignableUsers();
  // Keep an assigned person visible even if they have since been deactivated or moved office — a
  // controlled select whose value isn't in its options renders blank while still holding the id, so
  // the form would silently look "Unassigned" and re-save as such.
  const options = useMemo(() => {
    if (!value || users.some((user) => user.id === value)) return users;
    return [{ id: value, displayName: "Currently assigned (inactive)", email: "", role: "" }, ...users];
  }, [users, value]);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      disabled={loading}
      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13.5px] font-semibold text-slate-700"
    >
      <option value="">Unassigned</option>
      {options.map((person) => (
        <option key={person.id} value={person.id}>
          {person.displayName}
        </option>
      ))}
    </select>
  );
}
