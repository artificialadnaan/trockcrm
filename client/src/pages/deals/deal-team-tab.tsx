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
  // Exactly one of userId / contactId is set (server one-of check): app-user members carry userId,
  // CRM-contact members carry contactId. The server resolves displayName/email for BOTH, so the list
  // renders them identically without branching on which id is present.
  userId: string | null;
  contactId: string | null;
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
                  {member.notes && (
                    <p className="text-xs text-muted-foreground truncate">{member.notes}</p>
                  )}
                </div>
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

  // A member is EITHER an app user OR a CRM contact — the server (one-of check) accepts { userId, ... }
  // or { contactId, ... }. Default to the existing user flow so nothing changes for that path.
  const [mode, setMode] = useState<"user" | "contact">("user");
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactSuggestion[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactSuggestion | null>(null);
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
    if (!role) {
      toast.error("Please select a role");
      return;
    }
    if (mode === "user" && !userId) {
      toast.error("Please select a user");
      return;
    }
    if (mode === "contact" && !selectedContact) {
      toast.error("Please select a contact");
      return;
    }
    setSubmitting(true);
    try {
      await api(`/deals/${dealId}/team`, {
        method: "POST",
        json:
          mode === "contact"
            ? { contactId: selectedContact!.id, role, notes: notes.trim() || null }
            : { userId, role, notes: notes.trim() || null },
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
          {/* User / Contact segmented toggle: assign an app user OR a CRM contact. Switching clears the
              other mode's selection so we never submit a stale id from the hidden picker. */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Assign</span>
            <div className="inline-flex rounded-md border p-0.5">
              {(["user", "contact"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setUserId("");
                    setContactQuery("");
                    setContactResults([]);
                    setSelectedContact(null);
                    ++searchSeq.current;
                  }}
                  className={`px-3 py-1 text-sm rounded ${
                    mode === m
                      ? "bg-[#CC0000] text-white"
                      : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {m === "user" ? "User" : "Contact"}
                </button>
              ))}
            </div>
          </div>

          {mode === "user" ? (
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
                {(Object.keys(ROLE_LABELS) as TeamRole[]).map((r) => (
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
