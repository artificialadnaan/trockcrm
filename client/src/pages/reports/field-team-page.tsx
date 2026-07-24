import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Plus, Users, Pencil, ChevronRight, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import {
  FIELD_RESPONDER_ROLE_LABELS,
  FIELD_RESPONDER_ROLES,
  type FieldResponder,
  type FieldResponderAssignment,
  type FieldResponderRole,
} from "@trock-crm/shared/types";
import {
  useFieldResponders,
  createFieldResponder,
  updateFieldResponder,
  getFieldResponderAssignments,
  isFieldResponderEmailDuplicate,
} from "@/hooks/use-field-responders";

const ROLE_BADGE: Record<FieldResponderRole, string> = {
  superintendent: "border-red-200 bg-red-50 text-brand-red",
  project_manager: "border-amber-200 bg-amber-50 text-amber-700",
};

function roleLabel(role: FieldResponderRole) {
  return FIELD_RESPONDER_ROLE_LABELS[role] ?? role;
}

export default function FieldTeamPage() {
  const { user } = useAuth();
  // Writes (Add / Edit / Deactivate) are director/admin only server-side (requireDirector = office-effective
  // admin/director). Gate the controls on the effective role so a rep sees a read-only roster.
  const canManage = user?.role === "admin" || user?.role === "director";

  // Current cross-office scope (?officeId) — the api() layer forwards it as the x-office-id header. We thread it
  // through so the roster reloads when the office changes and so drill-down deal links stay in-scope (a link that
  // dropped officeId would open the deal under the user's default office and 404 when it lives only in scope).
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");

  const [showInactive, setShowInactive] = useState(false);
  const { responders, loading, error, refetch } = useFieldResponders({ includeInactive: showInactive, officeId });

  const [editing, setEditing] = useState<FieldResponder | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [drill, setDrill] = useState<FieldResponder | null>(null);

  const counts = useMemo(() => {
    const active = responders.filter((r) => r.isActive).length;
    const supers = responders.filter((r) => r.role === "superintendent").length;
    const pms = responders.filter((r) => r.role === "project_manager").length;
    return { active, supers, pms };
  }, [responders]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Field Team · Managed Roster"
        title="Field Team"
        description="The managed roster of field Superintendents & Project Managers used as corrective-action recipients across deals. Add them once here, then assign from the deal Team tab — no more retyping name and email per deal."
        actions={
          canManage
            ? {
                primary: (
                  <Button onClick={() => setAddOpen(true)} className="bg-brand-red text-white hover:bg-brand-red/90">
                    <Plus className="mr-1.5 h-4 w-4" /> Add Responder
                  </Button>
                ),
              }
            : undefined
        }
      />

      {/* filter row: show-inactive toggle + summary counts */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <button
          type="button"
          onClick={() => setShowInactive((v) => !v)}
          aria-pressed={showInactive}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] font-bold ${
            showInactive ? "border-slate-300 bg-slate-100 text-slate-700" : "border-slate-200 bg-slate-50 text-slate-500"
          }`}
        >
          {showInactive ? "Showing inactive" : "Show inactive"}
        </button>
        <div className="flex items-center gap-4 text-[12px] font-semibold text-slate-500">
          <span>{counts.active} active</span>
          <span className="text-slate-300">·</span>
          <span>{counts.supers} Superintendent{counts.supers === 1 ? "" : "s"}</span>
          <span className="text-slate-300">·</span>
          <span>{counts.pms} Project Manager{counts.pms === 1 ? "" : "s"}</span>
        </div>
      </div>

      {/* table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="text-[13px] font-bold text-slate-900">
            Responders <span className="font-semibold text-slate-400">· {responders.length}</span>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading roster…
          </div>
        ) : error ? (
          <div className="py-14 text-center">
            <p className="text-sm text-brand-red">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : responders.length === 0 ? (
          <div className="py-16 text-center">
            <Users className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-900">No field responders yet</p>
            <p className="mt-1 text-sm text-slate-500">
              {canManage ? "Add a Superintendent or Project Manager to the roster." : "The roster is empty."}
            </p>
          </div>
        ) : (
          // overflow-x-auto so the 6-column table (with unbreakable emails) stays reachable on phone widths —
          // the outer card is overflow-hidden for its rounded corners, which would otherwise clip the trailing
          // columns with no way to scroll to them. min-w keeps it a real scroll region rather than squishing.
          <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse">
            <thead>
              <tr className="border-b border-slate-100">
                <Th>Name</Th>
                <Th>Email</Th>
                <Th className="text-center">Role</Th>
                <Th className="text-center">Status</Th>
                <Th className="text-center">Assignments</Th>
                {canManage && <Th className="text-right" />}
              </tr>
            </thead>
            <tbody>
              {responders.map((r) => (
                <tr key={r.id} className={`border-b border-slate-100 ${r.isActive ? "" : "bg-slate-50/60"}`}>
                  <td className="px-3.5 py-3">
                    <div className={`font-semibold ${r.isActive ? "text-slate-950" : "text-slate-500"}`}>{r.name}</div>
                  </td>
                  <td className="px-3.5 py-3 text-[13px] text-slate-600">{r.email}</td>
                  <td className="px-3.5 py-3 text-center">
                    <Badge variant="outline" className={`${ROLE_BADGE[r.role]} whitespace-nowrap text-[10px] font-bold uppercase tracking-wide`}>
                      {roleLabel(r.role)}
                    </Badge>
                  </td>
                  <td className="px-3.5 py-3 text-center">
                    {r.isActive ? (
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-slate-200 bg-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        Inactive
                      </Badge>
                    )}
                  </td>
                  <td className="px-3.5 py-3 text-center">
                    {r.assignmentCount > 0 ? (
                      canManage ? (
                        <button
                          type="button"
                          onClick={() => setDrill(r)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-bold text-slate-800 hover:bg-slate-100"
                          aria-label={`View the ${r.assignmentCount} deal${r.assignmentCount === 1 ? "" : "s"} ${r.name} is assigned to`}
                        >
                          {r.assignmentCount}
                          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                        </button>
                      ) : (
                        // Reps see the aggregate count but not the per-deal drill-down — that list names deals
                        // across all reps and is director/admin only (matches the requireDirector endpoint).
                        <span className="text-[13px] font-bold text-slate-800">{r.assignmentCount}</span>
                      )
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3.5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        title="Edit responder"
                        aria-label={`Edit ${r.name}`}
                        className="inline-grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:border-brand-red hover:text-brand-red"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {canManage && (
        <ResponderFormDialog
          mode="add"
          open={addOpen}
          onOpenChange={setAddOpen}
          onSaved={() => void refetch()}
        />
      )}
      {canManage && editing && (
        <ResponderFormDialog
          mode="edit"
          responder={editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onSaved={() => void refetch()}
        />
      )}

      <AssignmentsSheet responder={drill} officeId={officeId} onClose={() => setDrill(null)} />
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3.5 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-slate-400 ${className}`}>{children}</th>;
}

// Permissive email shape check, mirroring the server isValidMemberEmail backstop.
function isValidResponderEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function ResponderFormDialog({
  mode,
  responder,
  open,
  onOpenChange,
  onSaved,
}: {
  mode: "add" | "edit";
  responder?: FieldResponder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(responder?.name ?? "");
  const [email, setEmail] = useState(responder?.email ?? "");
  const [role, setRole] = useState<FieldResponderRole>(responder?.role ?? "superintendent");
  const [isActive, setIsActive] = useState(responder?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Reseed the form whenever the dialog is (re)opened for a different responder, so editing row B never shows
  // row A's values, and the add form always opens blank.
  useEffect(() => {
    if (!open) return;
    setName(responder?.name ?? "");
    setEmail(responder?.email ?? "");
    setRole(responder?.role ?? "superintendent");
    setIsActive(responder?.isActive ?? true);
    setEmailError(null);
  }, [open, responder]);

  const handleSubmit = async () => {
    setEmailError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      toast.error("Please enter a name");
      return;
    }
    if (!isValidResponderEmail(trimmedEmail)) {
      toast.error("Please enter a valid email");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "add") {
        await createFieldResponder({ name: trimmedName, email: trimmedEmail, role });
        toast.success("Responder added to the roster");
      } else if (responder) {
        await updateFieldResponder(responder.id, {
          name: trimmedName,
          email: trimmedEmail,
          role,
          isActive,
        });
        toast.success("Responder updated");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      if (isFieldResponderEmailDuplicate(err)) {
        setEmailError("A responder with this email already exists on the roster.");
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to save responder");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Field Responder" : "Edit Field Responder"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label htmlFor="responder-name" className="text-sm font-medium">Name</label>
            <input
              id="responder-name"
              type="text"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="responder-email" className="text-sm font-medium">Email</label>
            <input
              id="responder-email"
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailError(null); }}
              className={`w-full rounded-md border px-2 py-1.5 text-sm ${emailError ? "border-brand-red" : ""}`}
              aria-invalid={emailError ? true : undefined}
            />
            {emailError && <p className="text-xs text-brand-red">{emailError}</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="responder-role" className="text-sm font-medium">Role</label>
            <select
              id="responder-role"
              value={role}
              onChange={(e) => setRole(e.target.value as FieldResponderRole)}
              className="w-full rounded-md border bg-white px-2 py-1.5 text-sm"
            >
              {FIELD_RESPONDER_ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </div>

          {mode === "edit" && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Active on the roster
              <span className="text-xs font-normal text-muted-foreground">
                (deactivate to retire — existing assignments are untouched)
              </span>
            </label>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Saving…" : mode === "add" ? "Add Responder" : "Save Changes"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AssignmentsSheet({
  responder,
  officeId,
  onClose,
}: {
  responder: FieldResponder | null;
  officeId: string | null;
  onClose: () => void;
}) {
  // Keep the current cross-office scope on deal links so the drill-down opens the deal in the same office it was
  // listed under (a bare /deals/:id would resolve to the user's default office and 404 an off-office deal).
  const dealHref = (dealId: string) =>
    `/deals/${dealId}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;
  const [deals, setDeals] = useState<FieldResponderAssignment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Monotonic request token: opening responder B while A's request is still in flight must not let A's slower
  // response overwrite B's deals (which would show A's deals under B's name and link to the wrong deal). Each
  // load bumps the token; a resolved response is applied only if it is still the latest.
  const requestTokenRef = useRef(0);
  const id = responder?.id ?? null;

  const load = useCallback(async () => {
    if (!id) return;
    const token = ++requestTokenRef.current;
    setLoading(true);
    setError(null);
    setDeals(null);
    try {
      const loaded = await getFieldResponderAssignments(id);
      if (token !== requestTokenRef.current) return; // a newer responder was opened; drop this stale response
      setDeals(loaded);
    } catch (e) {
      if (token !== requestTokenRef.current) return;
      setError(e instanceof Error ? e.message : "Couldn’t load assignments");
    } finally {
      if (token === requestTokenRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!responder) {
      // Sheet closed: invalidate any in-flight request (bump the token so its resolution is dropped) and clear
      // the previous deals, so a later open for a different responder never briefly renders these stale links.
      requestTokenRef.current += 1;
      setDeals(null);
      setError(null);
      setLoading(false);
      return;
    }
    void load();
  }, [responder, load, reloadKey]);

  return (
    <Sheet open={!!responder} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        {responder && (
          <>
            <SheetHeader className="shrink-0 border-b border-slate-100 px-6 py-5">
              <SheetTitle className="pr-8 leading-snug">{responder.name}</SheetTitle>
              <div className="text-[12.5px] text-slate-500">
                {[roleLabel(responder.role), responder.email].filter(Boolean).join(" · ")}
              </div>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Currently assigned on {responder.assignmentCount} deal{responder.assignmentCount === 1 ? "" : "s"}
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-10 text-sm text-slate-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading assignments…
                </div>
              ) : error ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-brand-red">{error}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
                </div>
              ) : deals && deals.length > 0 ? (
                <ul className="space-y-2">
                  {deals.map((d) => (
                    <li key={`${d.dealId}-${d.role}`}>
                      <a
                        href={dealHref(d.dealId)}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 hover:border-slate-300 hover:bg-slate-50"
                      >
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-slate-900">{d.dealName}</span>
                        <Badge variant="outline" className={`${ROLE_BADGE[d.role]} shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wide`}>
                          {roleLabel(d.role)}
                        </Badge>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="py-10 text-center text-sm text-slate-500">
                  Not assigned to any active deals.
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
