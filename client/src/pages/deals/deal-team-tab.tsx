import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, X, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { getOwnerInitialColor, type FieldResponder } from "@trock-crm/shared/types";
import { useAuth } from "@/lib/auth";
import {
  listFieldResponders,
  createFieldResponder,
  isFieldResponderEmailDuplicate,
} from "@/hooks/use-field-responders";

type TeamRole =
  | "superintendent"
  | "estimator"
  | "project_manager"
  | "client_services"
  | "operations"
  | "foreman"
  | "other";

interface TeamMember {
  id: string;
  dealId: string;
  // A member is a LINKED identity (userId XOR contactId) OR an email-only external (both null, isEmailOnly).
  // The server resolves displayName/email for ALL three, so the list renders them the same way; isEmailOnly
  // just adds a distinguishing badge for the external, no-login recipient.
  userId: string | null;
  contactId: string | null;
  isEmailOnly?: boolean;
  role: TeamRole;
  assignedBy: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

interface AdminUser {
  id: string;
  displayName: string;
  email: string;
}

// Shape returned by GET /contacts/search (same fields the Billing tab reads from that endpoint).
interface ContactSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
}

function getSelectedUserLabel(
  users: AdminUser[],
  userId: string,
  loadingUsers: boolean
) {
  if (loadingUsers) {
    return "Loading...";
  }

  if (!userId) {
    return "Select user";
  }

  return users.find((user) => user.id === userId)?.displayName ?? "Select user";
}

const ROLE_LABELS: Record<TeamRole, string> = {
  superintendent: "Superintendent",
  estimator: "Estimator",
  project_manager: "Project Manager",
  client_services: "Client Services",
  operations: "Operations",
  foreman: "Foreman",
  other: "Other",
};

// The third add mode ("email") is the FIELD-TEAM roster picker: pick an ACTIVE field_responder (migration 0198)
// and assign them as an email-only corrective-action recipient by sending { responderId } — the roster row's
// name/email/role are copied server-side, so no more retyping per deal. The mode value stays "email" so the
// super/PM role restriction (rolesForMode) + segmented-toggle plumbing are unchanged.
type AddMemberMode = "user" | "contact" | "email";

// A roster responder / email-only member exists ONLY to be a corrective-action recipient (spec §4.4/§6), so it
// is restricted to the super/PM roles the corrective-action flow resolves. Mirrors the server
// EMAIL_ONLY_TEAM_ROLES gate + the field_responders.role CHECK.
const EMAIL_ONLY_ROLES: TeamRole[] = ["superintendent", "project_manager"];

// A contact-backed estimator is rejected 400 by the server (an estimator must be a staff user, since
// revision routing only picks estimator rows whose user_id IS NOT NULL). So the role picker only offers
// Estimator in USER mode. Email mode only offers super/PM.
function rolesForMode(mode: AddMemberMode): TeamRole[] {
  const roles = Object.keys(ROLE_LABELS) as TeamRole[];
  if (mode === "email") return EMAIL_ONLY_ROLES;
  return mode === "contact" ? roles.filter((r) => r !== "estimator") : roles;
}

// Permissive email shape check (mirrors the server isValidMemberEmail backstop): a single @ with non-empty
// local + dotted domain parts.
export function isValidEmailOnlyMemberEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Pure validation for the add-member form (unit-tested). Returns an error message, or null when valid.
 * Email mode requires a name, a valid email, and a super/PM role; user/contact modes require their picker.
 */
export function validateAddMemberForm(input: {
  mode: AddMemberMode;
  role: TeamRole | "";
  userId: string;
  hasSelectedContact: boolean;
  memberName: string;
  memberEmail: string;
}): string | null {
  if (!input.role) return "Please select a role";
  if (input.mode === "user" && !input.userId) return "Please select a user";
  if (input.mode === "contact" && !input.hasSelectedContact) return "Please select a contact";
  if (input.mode === "email") {
    if (!input.memberName.trim()) return "Please enter a name";
    if (!isValidEmailOnlyMemberEmail(input.memberEmail)) return "Please enter a valid email";
    if (!EMAIL_ONLY_ROLES.includes(input.role)) {
      return "An email-only member must be a Superintendent or Project Manager";
    }
  }
  return null;
}

const ROLE_BADGE_CLASSES: Record<TeamRole, string> = {
  superintendent: "bg-red-100 text-red-700 border-red-200",
  estimator: "bg-blue-100 text-blue-700 border-blue-200",
  project_manager: "bg-amber-100 text-amber-700 border-amber-200",
  client_services: "bg-emerald-100 text-emerald-700 border-emerald-200",
  operations: "bg-violet-100 text-violet-700 border-violet-200",
  foreman: "bg-green-100 text-green-700 border-green-200",
  other: "bg-gray-100 text-gray-700 border-gray-200",
};

interface DealTeamTabProps {
  dealId: string;
  onCountChange?: (count: number) => void;
}

export function DealTeamTab({ dealId, onCountChange }: DealTeamTabProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchTeam = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ members: TeamMember[] }>(`/deals/${dealId}/team`);
      setMembers(data.members);
      setError(null);
      onCountChange?.(data.members.length);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load team");
      setError("Failed to load team");
    } finally {
      setLoading(false);
    }
  }, [dealId, onCountChange]);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  const handleRemove = async (memberId: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the team?`)) return;
    try {
      await api(`/deals/${dealId}/team/${memberId}`, { method: "DELETE" });
      toast.success("Team member removed");
      fetchTeam();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          className="mt-2 text-sm text-[#CC0000] hover:underline"
          onClick={fetchTeam}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {members.length} team member{members.length !== 1 ? "s" : ""} assigned
        </h3>
        <AddMemberDialog
          dealId={dealId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onAdded={fetchTeam}
        />
      </div>

      {members.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-muted/20">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-3">No team members assigned yet</p>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Team Member
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {members.map((member) => {
            const ownerColor = getOwnerInitialColor(member.userId ?? member.displayName);
            return (
              <div
                key={member.id}
                className="flex items-center gap-3 px-4 py-3 border rounded-lg bg-card hover:bg-muted/30 transition-colors"
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                  style={{ backgroundColor: ownerColor.backgroundColor, color: ownerColor.textColor }}
                >
                  {member.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{member.displayName}</p>
                  {member.isEmailOnly ? (
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  ) : member.notes ? (
                    <p className="text-xs text-muted-foreground truncate">{member.notes}</p>
                  ) : null}
                </div>
                {member.isEmailOnly && (
                  <Badge
                    variant="outline"
                    className="text-xs flex-shrink-0 bg-slate-100 text-slate-600 border-slate-200"
                  >
                    External
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={`text-xs flex-shrink-0 ${ROLE_BADGE_CLASSES[member.role]}`}
                >
                  {ROLE_LABELS[member.role]}
                </Badge>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {new Date(member.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  onClick={() => handleRemove(member.id, member.displayName)}
                  className="flex-shrink-0 text-muted-foreground hover:text-red-600 transition-colors p-1 rounded"
                  aria-label={`Remove ${member.displayName}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddMemberDialog({
  dealId,
  open,
  onOpenChange,
  onAdded,
}: {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  // Writes to the roster (Add new to roster) are director/admin only server-side (requireDirector); a rep can
  // still PICK an existing active responder. Gate the inline add-form on the effective office role.
  const { user } = useAuth();
  const canManageRoster = user?.role === "admin" || user?.role === "director";

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<TeamRole | "">("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // A member is an app user, a CRM contact, OR a field-team roster responder (spec §4.4). The server accepts
  // { userId }, { contactId }, or { responderId }. Default to the existing user flow.
  const [mode, setMode] = useState<AddMemberMode>("user");
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactSuggestion[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactSuggestion | null>(null);

  // Field-team roster picker (mode === "email"): the ACTIVE responders + the one the user selected. The role
  // is the roster row's — no role picker in this mode. `responderQuery` filters the loaded list client-side.
  const [responders, setResponders] = useState<FieldResponder[]>([]);
  const [loadingResponders, setLoadingResponders] = useState(false);
  const [responderQuery, setResponderQuery] = useState("");
  const [selectedResponder, setSelectedResponder] = useState<FieldResponder | null>(null);
  // Inline "Add new to roster" (director/admin only) fields.
  const [addingResponder, setAddingResponder] = useState(false);
  const [newResponderName, setNewResponderName] = useState("");
  const [newResponderEmail, setNewResponderEmail] = useState("");
  const [newResponderRole, setNewResponderRole] = useState<TeamRole>("superintendent");
  const [newResponderError, setNewResponderError] = useState<string | null>(null);
  const [savingResponder, setSavingResponder] = useState(false);
  // Same stale-response guard the Billing tab uses: bump on every keystroke so a slow earlier
  // /contacts/search response can't land after a newer query and overwrite it.
  const searchSeq = useRef(0);

  // Clear just the roster-picker + inline-add fields (used on mode switch and full reset).
  const resetResponderFields = () => {
    setResponderQuery("");
    setSelectedResponder(null);
    setAddingResponder(false);
    setNewResponderName("");
    setNewResponderEmail("");
    setNewResponderRole("superintendent");
    setNewResponderError(null);
  };

  const resetFields = () => {
    setUserId("");
    setRole("");
    setNotes("");
    setMode("user");
    setContactQuery("");
    setContactResults([]);
    setSelectedContact(null);
    resetResponderFields();
    ++searchSeq.current;
  };

  useEffect(() => {
    if (!open) return;
    setLoadingUsers(true);
    api<{ users: AdminUser[] }>(`/deals/${dealId}/team/assignable-users`)
      .then((data) => setUsers(data.users))
      .catch(() => toast.error("Failed to load users"))
      .finally(() => setLoadingUsers(false));
  }, [dealId, open]);

  // Load the ACTIVE field-team roster once the dialog opens (only active responders are freshly assignable —
  // the server 400s a deactivated one). Refetched when reopened so a just-added responder from another session
  // shows up.
  useEffect(() => {
    if (!open) return;
    setLoadingResponders(true);
    listFieldResponders({ includeInactive: false })
      .then((rows) => setResponders(rows))
      .catch(() => toast.error("Failed to load the field-team roster"))
      .finally(() => setLoadingResponders(false));
  }, [open]);

  // Copied from the Billing tab's contact search+select: GET /contacts/search?q=…&limit=10 → { contacts }.
  // Under 2 chars clears results; a sequence guard drops out-of-order responses.
  const runContactSearch = (q: string) => {
    setContactQuery(q);
    setSelectedContact(null);
    const seq = ++searchSeq.current;
    if (q.trim().length < 2) {
      setContactResults([]);
      return;
    }
    api<{ contacts: ContactSuggestion[] }>(
      `/contacts/search?q=${encodeURIComponent(q.trim())}&limit=10`
    ).then(
      (res) => { if (seq === searchSeq.current) setContactResults(res.contacts); },
      () => { if (seq === searchSeq.current) setContactResults([]); }
    );
  };

  const handleSubmit = async () => {
    // Field-team roster mode: pick an ACTIVE responder → send { responderId }. The roster row carries the
    // role, so there is no role picker to validate here; the server copies name/email/role from the roster.
    if (mode === "email") {
      if (!selectedResponder) {
        toast.error("Please pick a field-team responder");
        return;
      }
      setSubmitting(true);
      try {
        await api(`/deals/${dealId}/team`, {
          method: "POST",
          json: { responderId: selectedResponder.id, notes: notes.trim() || null },
        });
        toast.success("Team member added");
        onOpenChange(false);
        resetFields();
        onAdded();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Failed to add team member");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const validationError = validateAddMemberForm({
      mode,
      role,
      userId,
      hasSelectedContact: Boolean(selectedContact),
      memberName: "",
      memberEmail: "",
    });
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSubmitting(true);
    try {
      const json =
        mode === "contact"
          ? { contactId: selectedContact!.id, role, notes: notes.trim() || null }
          : { userId, role, notes: notes.trim() || null };
      await api(`/deals/${dealId}/team`, { method: "POST", json });
      toast.success("Team member added");
      onOpenChange(false);
      resetFields();
      onAdded();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add team member");
    } finally {
      setSubmitting(false);
    }
  };

  // Inline "Add new to roster" (director/admin only): POST a new field_responder, then select it in the picker
  // so the user can immediately assign them. A duplicate-email 409 surfaces inline on the email field.
  const handleAddResponder = async () => {
    setNewResponderError(null);
    const trimmedName = newResponderName.trim();
    const trimmedEmail = newResponderEmail.trim();
    if (!trimmedName) {
      setNewResponderError("Please enter a name");
      return;
    }
    if (!isValidEmailOnlyMemberEmail(trimmedEmail)) {
      setNewResponderError("Please enter a valid email");
      return;
    }
    setSavingResponder(true);
    try {
      const created = await createFieldResponder({
        name: trimmedName,
        email: trimmedEmail,
        // newResponderRole is constrained to the super/PM options in the picker below, matching the roster CHECK.
        role: newResponderRole as "superintendent" | "project_manager",
      });
      setResponders((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      setSelectedResponder(created);
      setAddingResponder(false);
      setNewResponderName("");
      setNewResponderEmail("");
      setNewResponderRole("superintendent");
      toast.success("Added to the field-team roster");
    } catch (err: unknown) {
      if (isFieldResponderEmailDuplicate(err)) {
        setNewResponderError("A responder with this email already exists on the roster.");
      } else {
        setNewResponderError(err instanceof Error ? err.message : "Failed to add responder");
      }
    } finally {
      setSavingResponder(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Add Team Member
          </Button>
        }
      />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Team Member</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          {/* User / Contact / Email segmented toggle: assign an app user, a CRM contact, OR an email-only
              external super/PM (spec §4.4). Switching clears the other modes' selections so we never submit
              a stale id from a hidden picker. */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Assign</span>
            <div className="inline-flex rounded-md border p-0.5">
              {(["user", "contact", "email"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    // Re-selecting the ALREADY-active mode is a no-op: don't wipe the in-progress selection /
                    // search / member fields the user is filling in. Only reset when actually switching modes.
                    if (m === mode) return;
                    setMode(m);
                    setUserId("");
                    setContactQuery("");
                    setContactResults([]);
                    setSelectedContact(null);
                    resetResponderFields();
                    ++searchSeq.current;
                    // Estimator is user-only; email mode is super/PM-only. Clear a now-invalid role so the
                    // picker + submitted role stay consistent with what the server will accept.
                    if (m !== "user") {
                      setRole((prev) => (prev && rolesForMode(m).includes(prev) ? prev : ""));
                    }
                  }}
                  className={`px-3 py-1 text-sm rounded ${
                    mode === m
                      ? "bg-[#CC0000] text-white"
                      : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {m === "user" ? "User" : m === "contact" ? "Contact" : "Field Team"}
                </button>
              ))}
            </div>
          </div>

          {mode === "email" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                A Superintendent or Project Manager from the managed field-team roster. They receive
                corrective-action notifications and respond via a secure link.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="team-responder-search" className="text-sm font-medium">Field-team responder</label>
                {selectedResponder ? (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{selectedResponder.name}</span>
                      <span className="text-muted-foreground"> · {selectedResponder.email}</span>
                    </span>
                    <div className="ml-2 flex flex-shrink-0 items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[10px] font-bold uppercase tracking-wide ${ROLE_BADGE_CLASSES[selectedResponder.role]}`}
                      >
                        {ROLE_LABELS[selectedResponder.role]}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => { setSelectedResponder(null); setResponderQuery(""); }}
                        className="text-muted-foreground hover:text-red-600"
                        aria-label="Clear selected responder"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <input
                      id="team-responder-search"
                      type="search"
                      placeholder={loadingResponders ? "Loading roster…" : "Search the field-team roster…"}
                      value={responderQuery}
                      onChange={(e) => setResponderQuery(e.target.value)}
                      disabled={loadingResponders}
                      className="w-full rounded-md border px-2 py-1.5 text-sm"
                    />
                    {(() => {
                      const q = responderQuery.trim().toLowerCase();
                      const matches = q
                        ? responders.filter(
                            (r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q),
                          )
                        : responders;
                      if (loadingResponders) return null;
                      if (matches.length === 0) {
                        return (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {responders.length === 0
                              ? "No responders on the roster yet."
                              : "No responders match your search."}
                          </p>
                        );
                      }
                      return (
                        <ul className="mt-1 max-h-52 divide-y overflow-y-auto rounded-md border">
                          {matches.map((r) => (
                            <li key={r.id}>
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                                onClick={() => { setSelectedResponder(r); setResponderQuery(""); }}
                              >
                                <span className="min-w-0 truncate">
                                  <span className="font-medium">{r.name}</span>
                                  <span className="text-muted-foreground"> · {r.email}</span>
                                </span>
                                <Badge
                                  variant="outline"
                                  className={`flex-shrink-0 text-[10px] font-bold uppercase tracking-wide ${ROLE_BADGE_CLASSES[r.role]}`}
                                >
                                  {ROLE_LABELS[r.role]}
                                </Badge>
                              </button>
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </>
                )}
              </div>

              {/* Inline "Add new to roster" — director/admin only (a rep just picks an existing responder). */}
              {canManageRoster && !selectedResponder && (
                addingResponder ? (
                  <div className="space-y-2 rounded-md border border-dashed p-3">
                    <p className="text-xs font-semibold text-muted-foreground">New roster responder</p>
                    <input
                      type="text"
                      placeholder="Full name"
                      value={newResponderName}
                      onChange={(e) => { setNewResponderName(e.target.value); setNewResponderError(null); }}
                      className="w-full rounded-md border px-2 py-1.5 text-sm"
                      aria-label="New responder name"
                    />
                    <input
                      type="email"
                      placeholder="name@example.com"
                      value={newResponderEmail}
                      onChange={(e) => { setNewResponderEmail(e.target.value); setNewResponderError(null); }}
                      className={`w-full rounded-md border px-2 py-1.5 text-sm ${newResponderError ? "border-[#CC0000]" : ""}`}
                      aria-label="New responder email"
                    />
                    <Select value={newResponderRole} onValueChange={(v) => setNewResponderRole((v ?? "superintendent") as TeamRole)}>
                      <SelectTrigger aria-label="New responder role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EMAIL_ONLY_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {newResponderError && <p className="text-xs text-[#CC0000]">{newResponderError}</p>}
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => { setAddingResponder(false); setNewResponderError(null); }}
                        disabled={savingResponder}
                      >
                        Cancel
                      </Button>
                      <Button type="button" size="sm" onClick={handleAddResponder} disabled={savingResponder}>
                        {savingResponder ? "Adding…" : "Add to roster"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingResponder(true)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#CC0000] hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add new to roster
                  </button>
                )
              )}
            </div>
          ) : mode === "user" ? (
            <div className="space-y-1.5">
              <label id="team-user-label" htmlFor="team-user-select" className="text-sm font-medium">User</label>
              <Select value={userId} onValueChange={(v) => setUserId(v ?? "")} disabled={loadingUsers}>
                <SelectTrigger id="team-user-select" aria-labelledby="team-user-label">
                  <SelectValue placeholder={loadingUsers ? "Loading..." : "Select user"}>
                    {getSelectedUserLabel(users, userId, loadingUsers)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="team-contact-search" className="text-sm font-medium">Contact</label>
              {selectedContact ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">
                    {selectedContact.firstName} {selectedContact.lastName}
                    {selectedContact.companyName ? ` — ${selectedContact.companyName}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setSelectedContact(null); setContactQuery(""); setContactResults([]); ++searchSeq.current; }}
                    className="ml-2 flex-shrink-0 text-muted-foreground hover:text-red-600"
                    aria-label="Clear selected contact"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <input
                    id="team-contact-search"
                    type="search"
                    placeholder="Search contacts…"
                    value={contactQuery}
                    onChange={(e) => runContactSearch(e.target.value)}
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                  />
                  {contactResults.length > 0 ? (
                    <ul className="mt-1 divide-y rounded-md border">
                      {contactResults.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                            onClick={() => { setSelectedContact(c); setContactResults([]); }}
                          >
                            {c.firstName} {c.lastName}{c.companyName ? ` — ${c.companyName}` : ""}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* The role picker is hidden in field-team mode — the roster row's role is authoritative and copied
              server-side (the server ignores a client-sent role on a { responderId } add). */}
          {mode !== "email" && (
            <div className="space-y-1.5">
              <label id="team-role-label" htmlFor="team-role-select" className="text-sm font-medium">Role</label>
              <Select value={role} onValueChange={(v) => setRole((v ?? "") as TeamRole)}>
                <SelectTrigger id="team-role-select" aria-labelledby="team-role-label">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {rolesForMode(mode).map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="team-notes" className="text-sm font-medium">Notes (optional)</label>
            <Textarea
              id="team-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional context..."
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { onOpenChange(false); resetFields(); }} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Adding..." : "Add Member"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
