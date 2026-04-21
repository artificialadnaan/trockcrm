import { useState, useEffect, useCallback } from "react";
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
  userId: string;
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

const AVATAR_BG_CLASSES: Record<TeamRole, string> = {
  superintendent: "bg-red-600",
  estimator: "bg-blue-600",
  project_manager: "bg-amber-600",
  client_services: "bg-emerald-600",
  operations: "bg-violet-600",
  foreman: "bg-green-600",
  other: "bg-gray-600",
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
          {members.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 px-4 py-3 border rounded-lg bg-card hover:bg-muted/30 transition-colors"
            >
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0 ${AVATAR_BG_CLASSES[member.role]}`}
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
          ))}
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

  useEffect(() => {
    if (!open) return;
    setLoadingUsers(true);
    api<{ users: AdminUser[] }>("/admin/users")
      .then((data) => setUsers(data.users))
      .catch(() => toast.error("Failed to load users"))
      .finally(() => setLoadingUsers(false));
  }, [open]);

  const handleSubmit = async () => {
    if (!userId || !role) {
      toast.error("Please select a user and role");
      return;
    }
    setSubmitting(true);
    try {
      await api(`/deals/${dealId}/team`, {
        method: "POST",
        json: { userId, role, notes: notes.trim() || null },
      });
      toast.success("Team member added");
      onOpenChange(false);
      setUserId("");
      setRole("");
      setNotes("");
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
          <div className="space-y-1.5">
            <label id="team-user-label" htmlFor="team-user-select" className="text-sm font-medium">User</label>
            <Select value={userId} onValueChange={(v) => setUserId(v ?? "")} disabled={loadingUsers}>
              <SelectTrigger id="team-user-select" aria-labelledby="team-user-label">
                <SelectValue placeholder={loadingUsers ? "Loading..." : "Select user"} />
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
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
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
