import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  createWeeklyReportProject,
  deleteWeeklyReportProject,
  updateWeeklyReportProject,
  useWeeklyReportAssignableUsers,
  useWeeklyReportEligibleDeals,
  type WeeklyReportAssignableResponder,
  type WeeklyReportEligibleDeal,
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
  { key: "doc", label: "DOC", hint: "Director of construction" },
  { key: "pm", label: "PM", hint: "Project manager" },
  { key: "rm", label: "RM", hint: "Regional manager" },
  { key: "cm", label: "CM", hint: "Construction manager" },
] as const;

type ClientRole = (typeof CLIENT_ROLES)[number]["key"];

interface FormState {
  dealId: string;
  dealLabel: string;
  propertyDisplayName: string;
  clientName: string;
  clientTeam: Record<ClientRole, { name: string; email: string }>;
  trockPmResponderId: string;
  trockSuperResponderId: string;
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
    trockPmResponderId: "",
    trockSuperResponderId: "",
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
    trockPmResponderId: project.trockPmResponderId ?? "",
    trockSuperResponderId: project.trockSuperResponderId ?? "",
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
    // Roster ids, not user ids. The server derives the login from the roster row's email — a client
    // cannot nominate an arbitrary account into the slot that decides who may approve and send.
    trockPmResponderId: nullable(form.trockPmResponderId),
    trockSuperResponderId: nullable(form.trockSuperResponderId),
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
  onClose,
  onSaved,
}: {
  project: WeeklyReportProject | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => (project ? formFromProject(project) : emptyForm()));
  const [saving, setSaving] = useState(false);
  const { responders, loading: rosterLoading, error: rosterError } = useWeeklyReportAssignableUsers();

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
    // Escape, the backdrop and the close control all arrive here, and all three are ignored while a
    // request is in flight — the footer buttons being disabled is not enough. Closing mid-save does not
    // merely lose the edit: the request still resolves into `onSaved`, which clears the page's shared
    // creating/editing state and would therefore close whichever project dialog the user opened in the
    // meantime, discarding that form instead.
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        // Wide enough for a two-column body at desktop and for the date+note pairs to sit on one line.
        // `!max-w-*` because the primitive pins `sm:max-w-sm`, which a plain utility loses to.
        className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:!max-w-5xl"
      >
        <DialogHeader className="border-b border-slate-200 px-6 py-4">
          <DialogTitle className="text-[16px] font-extrabold tracking-tight text-slate-950">
            {project ? "Edit weekly report project" : "New weekly report project"}
          </DialogTitle>
          <p className="mt-0.5 text-[13.5px] text-slate-500">
            Who receives the client's weekly progress report, what prints on it, and how often it is due.
          </p>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-7">
              <Section
                title="Project"
                hint="Only Won jobs without an existing weekly report setup can be selected."
              >
                {project ? (
                  <Field label="Project">
                    <ReadOnlyValue>{form.dealLabel || form.propertyDisplayName || "—"}</ReadOnlyValue>
                  </Field>
                ) : (
                  <DealPicker
                    value={form.dealId}
                    label={form.dealLabel}
                    onPick={(deal) =>
                      setForm((prev) => ({
                        ...prev,
                        dealId: deal.id,
                        dealLabel: [deal.projectNumber ?? deal.dealNumber, deal.name]
                          .filter(Boolean)
                          .join(" · "),
                        // Seed from the job so the common case needs no typing, while each field stays
                        // independently editable. Only fills a field the user has left EMPTY — re-picking
                        // a job must not silently overwrite something they typed themselves.
                        propertyDisplayName: prev.propertyDisplayName || deal.name,
                        clientName: prev.clientName || deal.clientName || "",
                        contractDate: prev.contractDate || deal.contractSignedDate || "",
                      }))
                    }
                    onClear={() =>
                      setForm((prev) => ({ ...prev, dealId: "", dealLabel: "" }))
                    }
                  />
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Property name" hint="Prints as the report header">
                    <TextInput
                      value={form.propertyDisplayName}
                      onChange={(value) => setField("propertyDisplayName", value)}
                      placeholder="4123 Cedar Springs"
                    />
                  </Field>
                  <Field label="Client" hint="The company the work is for">
                    <TextInput
                      value={form.clientName}
                      onChange={(value) => setField("clientName", value)}
                      placeholder="Mack Real Estate Group"
                    />
                  </Field>
                </div>
              </Section>

              <Section
                title="T-Rock project team"
                hint="These two decide who can author, who must approve, and who gets the reminder emails."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Project manager">
                    <RosterSelect
                      value={form.trockPmResponderId}
                      onChange={(value) => setField("trockPmResponderId", value)}
                      responders={responders}
                      role="project_manager"
                      loading={rosterLoading}
                      error={rosterError}
                      ariaLabel="T-Rock project manager"
                      currentName={project?.trockPmName ?? null}
                    />
                  </Field>
                  <Field label="Superintendent">
                    <RosterSelect
                      value={form.trockSuperResponderId}
                      onChange={(value) => setField("trockSuperResponderId", value)}
                      responders={responders}
                      role="superintendent"
                      loading={rosterLoading}
                      error={rosterError}
                      ariaLabel="T-Rock superintendent"
                      currentName={project?.trockSuperName ?? null}
                    />
                  </Field>
                </div>
                <p className="text-[11.5px] text-slate-500">
                  This list is the Field Team roster — the same one used for corrective actions and QC
                  scorecards. Add or remove people there.
                </p>
              </Section>

              <Section title="Client team" hint="Who at the client's office appears on the report.">
                <div className="space-y-2.5">
                  {CLIENT_ROLES.map((role) => (
                    <div key={role.key} className="grid gap-2 sm:grid-cols-[72px_1fr_1fr] sm:items-center">
                      <span
                        className="text-[11px] font-bold uppercase tracking-wider text-slate-500"
                        title={role.hint}
                      >
                        {role.label}
                      </span>
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
              </Section>

              <Section
                title="Schedule"
                hint="A note prints in place of the date when the date isn't known yet — e.g. “TBD Permit”."
              >
                <div className="space-y-2.5">
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
                </div>
                <div className="sm:max-w-[220px]">
                  <Field label="Projected duration" hint="Weeks">
                    <TextInput
                      type="number"
                      value={form.projectedDurationWeeks}
                      onChange={(value) => setField("projectedDurationWeeks", value)}
                      placeholder="19"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Reporting cadence">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Due every">
                    <SelectInput
                      value={String(form.cadenceWeekday)}
                      onChange={(value) => setField("cadenceWeekday", Number(value))}
                      ariaLabel="Report due day"
                    >
                      {WEEKDAYS.map((day) => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Reporting starts">
                    <TextInput
                      type="date"
                      value={form.cadenceStartDate}
                      onChange={(value) => setField("cadenceStartDate", value)}
                    />
                  </Field>
                  <Field label="Reporting ends" hint="Optional">
                    <TextInput
                      type="date"
                      value={form.cadenceEndDate}
                      onChange={(value) => setField("cadenceEndDate", value)}
                    />
                  </Field>
                </div>
                {project && (
                  <div className="sm:max-w-[280px]">
                    <Field label="Status">
                      <SelectInput
                        value={form.status}
                        onChange={(value) => setField("status", value as FormState["status"])}
                        ariaLabel="Reporting status"
                      >
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="completed">Completed</option>
                      </SelectInput>
                    </Field>
                    <p className="mt-1.5 text-[11.5px] text-slate-500">
                      Paused and completed projects stop generating weeks and stop sending reminders.
                      Weeks missed before the pause stay on the board.
                    </p>
                  </div>
                )}
              </Section>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/60 px-6 py-3.5">
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

/**
 * A titled group of related fields.
 *
 * The form was previously a flat stack of `fieldset`s whose legends and field labels used the SAME
 * 11px all-caps token, so nothing on the page outranked anything else and there were sixteen equally
 * loud labels to read. Section titles now sit a full step above field labels, and the space above a
 * title is larger than the space below it, so the grouping is visible before any of it is read.
 */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3.5">
      <div className="border-b border-slate-200 pb-2">
        <h3 className="text-[13.5px] font-bold tracking-tight text-slate-900">{title}</h3>
        {hint && <p className="mt-0.5 text-[11.5px] text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
  /**
   * Render a <div> instead of a <label>.
   *
   * A <label> forwards a click to its first labelable descendant and may legally wrap at most ONE form
   * control. The project picker puts a search input AND a button per result inside its field, so as a
   * <label> it was both non-conforming and actively wrong: clicking a result row also activated the
   * search box. Anything with more than one control in it passes `asFieldset`.
   */
  asFieldset = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  asFieldset?: boolean;
}) {
  const Wrapper = asFieldset ? "div" : "label";
  return (
    <Wrapper className="block">
      <span className="mb-1.5 flex items-baseline gap-1.5">
        {/* slate-600, not the slate-400 this form used throughout: at 12px that was roughly 2.8:1 on
            white, under the 4.5:1 floor for text somebody has to read to fill the field in. */}
        <span className="text-[11.5px] font-semibold text-slate-700">{label}</span>
        {hint && <span className="text-[11.5px] font-normal text-slate-500">{hint}</span>}
      </span>
      {children}
    </Wrapper>
  );
}

function ReadOnlyValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[13.5px] font-semibold text-slate-700">
      {children}
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none " +
  // placeholder was slate-300 (~1.9:1) — invisible in daylight on a jobsite laptop, which is the scene
  // this form is actually used in.
  "placeholder:text-slate-400 transition-colors hover:border-slate-400 " +
  "focus:border-brand-red/50 focus:ring-2 focus:ring-brand-red/15 disabled:bg-slate-50 disabled:text-slate-500";

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
      className={INPUT_CLASS}
    />
  );
}

function SelectInput({
  value,
  onChange,
  ariaLabel,
  disabled,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${INPUT_CLASS} font-semibold`}
    >
      {children}
    </select>
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
    <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.3fr)] sm:items-center">
      <span className="text-[11.5px] font-semibold text-slate-700">{label}</span>
      <TextInput type="date" value={date} onChange={onDate} ariaLabel={`${label} date`} />
      <TextInput
        value={note}
        onChange={onNote}
        placeholder="or a note, e.g. TBD Permit"
        ariaLabel={`${label} note`}
      />
    </div>
  );
}

/**
 * Project picker.
 *
 * Backed by `/weekly-reports/eligible-deals`, which applies the SAME Won predicate the create path
 * enforces and drops jobs that already have a setup. The previous picker searched every active deal
 * (1,445 of them against live data) with no stage filter, so it happily offered a job the server then
 * refused with a 400 once the whole form had been filled in.
 */
function DealPicker({
  value,
  label,
  onPick,
  onClear,
}: {
  value: string;
  label: string;
  onPick: (deal: WeeklyReportEligibleDeal) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { deals, loading } = useWeeklyReportEligibleDeals(debounced, !value && debounced.length >= 2);

  if (value) {
    return (
      <Field label="Project" asFieldset>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ReadOnlyValue>{label}</ReadOnlyValue>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            <X className="mr-1 h-3.5 w-3.5" />
            Change
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field label="Project" hint="Required" asFieldset>
      <div className="relative">
        <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 focus-within:border-brand-red/50 focus-within:ring-2 focus-within:ring-brand-red/15">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(true);
            }}
            placeholder="Search Won jobs by name or project number"
            aria-label="Search for a project"
            className="w-full bg-transparent text-[13.5px] text-slate-900 outline-none placeholder:text-slate-400"
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />}
        </div>
        {open && debounced.length >= 2 && (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
            {deals.length === 0 && !loading ? (
              <p className="px-3 py-3 text-[13.5px] text-slate-500">
                No Won jobs match that. Jobs that already have a weekly report setup aren't listed.
              </p>
            ) : (
              deals.map((deal) => (
                <button
                  key={deal.id}
                  type="button"
                  onClick={() => {
                    onPick(deal);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="block w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
                >
                  <span className="block truncate text-[13.5px] font-semibold text-slate-900">
                    {deal.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-slate-500">
                    {deal.projectNumber ?? deal.dealNumber ?? "No project number"}
                    {deal.clientName ? ` · ${deal.clientName}` : ""}
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
 * PM / superintendent picker, fed by the office's FIELD TEAM ROSTER.
 *
 * It used to list `public.users` filtered to four broad roles, which against the live Dallas roster
 * could offer six of fifteen people: four are `rep` logins who are genuinely PMs and superintendents,
 * and five hold no CRM account at all. The roster is the list a director already curates for the deal
 * Team tab and the QC scorecards, and it holds all fifteen.
 *
 * Filtered to the role of the slot, because the roster's own role is what the server checks — offering a
 * superintendent in the PM picker would produce a 400 on save for no reason the user could see.
 */
function RosterSelect({
  value,
  onChange,
  responders,
  role,
  loading,
  error,
  ariaLabel,
  currentName,
}: {
  value: string;
  onChange: (value: string) => void;
  responders: WeeklyReportAssignableResponder[];
  role: "project_manager" | "superintendent";
  loading: boolean;
  /** A FAILED roster request. Distinct from an empty one — see below. */
  error: string | null;
  ariaLabel: string;
  currentName: string | null;
}) {
  const options = useMemo(() => responders.filter((person) => person.role === role), [responders, role]);

  // Keep an assigned person selectable even once they are off the roster. A controlled select whose
  // value is not among its options renders BLANK while still holding the id, so the form would look
  // "Unassigned" and re-save as such — quietly removing whoever was approving this project's reports.
  const missing = value && !options.some((person) => person.id === value);

  const selected = options.find((person) => person.id === value) ?? null;

  return (
    <div className="space-y-1.5">
      <SelectInput value={value} onChange={onChange} ariaLabel={ariaLabel} disabled={loading}>
        <option value="">{loading ? "Loading roster…" : "Unassigned"}</option>
        {missing && <option value={value}>{currentName ?? "Currently assigned"} (off the roster)</option>}
        {options.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {person.hasLogin ? "" : " — no app login"}
          </option>
        ))}
      </SelectInput>
      {/* A failed request and an empty roster are NOT the same thing, and saying "nobody holds this
          role" for a request that never landed is the worse of the two: it reads as a settled fact, and
          somebody acts on it by saving the project with the slot unassigned. */}
      {!loading && error && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-brand-red">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>Couldn't load the Field Team roster, so nobody can be picked. Reopen this form to retry.</span>
        </p>
      )}
      {!loading && !error && options.length === 0 && (
        <p className="text-[11.5px] text-slate-500">
          Nobody on the Field Team roster holds this role yet.
        </p>
      )}
      {selected && !selected.hasLogin && (
        // Stated where the choice is made, not discovered on a Thursday when a report needs approving.
        <p className="flex items-start gap-1.5 text-[11.5px] text-amber-700">
          <Info className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>
            {selected.name} has no CRM login, so they can't approve or send from the app. Their name still
            prints on the report and they still get the reminder emails — a director approves on their
            behalf.
          </span>
        </p>
      )}
    </div>
  );
}
