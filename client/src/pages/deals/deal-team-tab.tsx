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
import { getOwnerInitialColor } from "@trock-crm/shared/types";

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

type AddMemberMode = "user" | "contact" | "email";

// An email-only member exists ONLY to be a corrective-action recipient (spec §4.4/§6), so it is restricted
// to the super/PM roles the corrective-action flow resolves. Mirrors the server EMAIL_ONLY_TEAM_ROLES gate.
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
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<TeamRole | "">("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // A member is an app user, a CRM contact, OR an email-only external (spec §4.4). The server accepts
  // { userId }, { contactId }, or { memberName, memberEmail }. Default to the existing user flow.
  const [mode, setMode] = useState<AddMemberMode>("user");
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactSuggestion[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactSuggestion | null>(null);
  // Email-only member fields.
  const [memberName, setMemberName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  // Same stale-response guard the Billing tab uses: bump on every keystroke so a slow earlier
  // /contacts/search response can't land after a newer query and overwrite it.
  const searchSeq = useRef(0);

  const resetFields = () => {
    setUserId("");
    setRole("");
    setNotes("");
    setMode("user");
    setContactQuery("");
    setContactResults([]);
    setSelectedContact(null);
    setMemberName("");
    setMemberEmail("");
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
    const validationError = validateAddMemberForm({
      mode,
      role,
      userId,
      hasSelectedContact: Boolean(selectedContact),
      memberName,
      memberEmail,
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
          : mode === "email"
            ? { memberName: memberName.trim(), memberEmail: memberEmail.trim(), role, notes: notes.trim() || null }
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
                    setMode(m);
                    setUserId("");
                    setContactQuery("");
                    setContactResults([]);
                    setSelectedContact(null);
                    setMemberName("");
                    setMemberEmail("");
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
                  {m === "user" ? "User" : m === "contact" ? "Contact" : "Email"}
                </button>
              ))}
            </div>
          </div>

          {mode === "email" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                An external Superintendent or Project Manager with no CRM login. They receive corrective-action
                notifications and respond via a secure link.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="team-member-name" className="text-sm font-medium">Name</label>
                <input
                  id="team-member-name"
                  type="text"
                  placeholder="Full name"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="team-member-email" className="text-sm font-medium">Email</label>
                <input
                  id="team-member-email"
                  type="email"
                  placeholder="name@example.com"
                  value={memberEmail}
                  onChange={(e) => setMemberEmail(e.target.value)}
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                />
              </div>
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
