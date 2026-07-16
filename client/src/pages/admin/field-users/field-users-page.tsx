import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { KeyRound, MailPlus, RefreshCw, Search, UserCheck, UserX, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

type FieldUserStatus = "accepted" | "pending" | "expired" | "revoked";
type StatusFilter = "all" | "active" | "inactive" | "pending-invite";

interface FieldUserRow {
  id: string;
  userId: string | null;
  inviteId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  inviteStatus: FieldUserStatus;
  invitedBy: { id: string; name: string } | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  expiresAt: string | null;
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "pending-invite", label: "Pending Invite" },
];

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";
}

function formatDate(value: string | null) {
  if (!value) return "Not yet";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusBadge(row: FieldUserRow) {
  if (row.inviteStatus === "pending") return <Badge variant="outline">Pending Invite</Badge>;
  if (row.inviteStatus === "expired") return <Badge variant="destructive">Expired Invite</Badge>;
  if (row.inviteStatus === "revoked") return <Badge variant="outline">Revoked Invite</Badge>;
  return row.active ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>;
}

export function FieldUsersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState<FieldUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(Number(searchParams.get("page") ?? "1"));
  const [perPage, setPerPage] = useState(Number(searchParams.get("perPage") ?? "25"));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", firstName: "", lastName: "", phone: "" });
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const resetInFlightRef = useRef(false);

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const status = (searchParams.get("status") as StatusFilter | null) ?? "all";
  const search = searchParams.get("search") ?? "";

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    params.set("page", searchParams.get("page") ?? "1");
    params.set("perPage", searchParams.get("perPage") ?? "25");
    return params.toString();
  }, [search, searchParams, status]);

  const updateParams = useCallback((updater: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    updater(next);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ users: FieldUserRow[]; total: number; page: number; perPage: number }>(`/admin/field-users?${queryString}`);
      setUsers(data.users);
      setTotal(data.total);
      setPage(data.page);
      setPerPage(data.perPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load field users");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  async function submitInvite() {
    setInviteSubmitting(true);
    setInviteError(null);
    try {
      await api<{ invite: { id: string; email: string; expiresAt: string } }>("/admin/field-users/invite", {
        method: "POST",
        json: {
          email: inviteForm.email,
          firstName: inviteForm.firstName,
          lastName: inviteForm.lastName,
          phone: inviteForm.phone || undefined,
        },
      });
      toast.success(`Invite sent to ${inviteForm.email}`);
      setInviteOpen(false);
      setInviteForm({ email: "", firstName: "", lastName: "", phone: "" });
      await fetchUsers();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function resendInvite(row: FieldUserRow) {
    await api(`/admin/field-users/${row.inviteId ?? row.id}/resend-invite`, { method: "POST" });
    toast.success(`Invite resent to ${row.email}`);
    await fetchUsers();
  }

  async function cancelInvite(row: FieldUserRow) {
    if (!window.confirm(`Cancel pending invite for ${row.email}? They will need a new invite to join.`)) return;
    await api(`/admin/field-users/invites/${row.inviteId ?? row.id}/revoke`, { method: "POST" });
    toast.success("Invite cancelled");
    await fetchUsers();
  }

  async function deactivate(row: FieldUserRow) {
    if (!window.confirm(`Deactivate ${row.firstName} ${row.lastName}? They will be signed out and unable to log in until reactivated.`)) return;
    await api(`/admin/field-users/${row.userId ?? row.id}/deactivate`, { method: "POST" });
    toast.success("Field user deactivated");
    await fetchUsers();
  }

  async function reactivate(row: FieldUserRow) {
    await api(`/admin/field-users/${row.userId ?? row.id}/reactivate`, { method: "POST" });
    toast.success("Field user reactivated");
    await fetchUsers();
  }

  async function resetPassword(row: FieldUserRow) {
    const userId = row.userId ?? row.id;
    if (resetInFlightRef.current) return;
    if (!window.confirm(
      `Send a password reset link to ${row.firstName} ${row.lastName} at ${row.email}? The single-use link will expire in 30 minutes.`
    )) return;
    resetInFlightRef.current = true;
    setResettingUserId(userId);
    try {
      await api(`/admin/field-users/${userId}/reset-password`, { method: "POST" });
      toast.success(`Password reset link sent to ${row.email}`);
      await fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      resetInFlightRef.current = false;
      setResettingUserId(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Field Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">{total.toLocaleString()} field users and invites</p>
        </div>
        <Button type="button" aria-label="Invite field user" onClick={() => setInviteOpen(true)}>
          <MailPlus className="mr-1.5 h-4 w-4" />
          Invite User
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-8 w-64 pl-8"
            placeholder="Search field users"
            value={search}
            onChange={(event) => updateParams((params) => {
              event.target.value ? params.set("search", event.target.value) : params.delete("search");
              params.set("page", "1");
            })}
          />
        </div>
        <div className="flex rounded-md border bg-background p-0.5">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`rounded px-2.5 py-1 text-xs font-medium ${status === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateParams((params) => {
                option.value === "all" ? params.delete("status") : params.set("status", option.value);
                params.set("page", "1");
              })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {(search || status !== "all") && (
          <Button variant="ghost" size="sm" onClick={() => setSearchParams(new URLSearchParams())}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => fetchUsers()}>Retry</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Invited by</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading field users...</TableCell></TableRow>
            ) : users.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No field users yet. Click Invite User to get started.</TableCell></TableRow>
            ) : users.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Avatar className="h-8 w-8"><AvatarFallback>{initials(row.firstName, row.lastName)}</AvatarFallback></Avatar>
                    <span className="font-medium">{row.firstName} {row.lastName}</span>
                  </div>
                </TableCell>
                <TableCell>{row.email}</TableCell>
                <TableCell>{row.phone || "N/A"}</TableCell>
                <TableCell>{statusBadge(row)}</TableCell>
                <TableCell>{row.invitedBy?.name ?? "N/A"}</TableCell>
                <TableCell>{formatDate(row.acceptedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {row.inviteStatus === "pending" && (
                      <>
                        <Button type="button" variant="ghost" size="sm" aria-label="Resend invite" onClick={() => resendInvite(row)}>
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" aria-label="Cancel invite" onClick={() => cancelInvite(row)}>
                          <UserX className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {row.inviteStatus === "accepted" && row.active && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="Reset field user password"
                          disabled={Boolean(resettingUserId)}
                          onClick={() => resetPassword(row)}
                        >
                          <KeyRound className="mr-1 h-4 w-4" />
                          {resettingUserId === (row.userId ?? row.id) ? "Resetting…" : "Reset password"}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" aria-label="Deactivate field user" onClick={() => deactivate(row)}>
                          <UserX className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {row.inviteStatus === "accepted" && !row.active && (
                      <Button type="button" variant="ghost" size="sm" aria-label="Reactivate field user" onClick={() => reactivate(row)}>
                        <UserCheck className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Page {page} of {totalPages}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateParams((params) => params.set("page", String(page - 1)))}>Previous</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => updateParams((params) => params.set("page", String(page + 1)))}>Next</Button>
        </div>
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>Send a field app invite by email. The invite expires in 7 days.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input name="email" placeholder="Email" value={inviteForm.email} onChange={(event) => setInviteForm((form) => ({ ...form, email: event.target.value }))} />
            <div className="grid grid-cols-2 gap-2">
              <Input name="firstName" placeholder="First name" value={inviteForm.firstName} onChange={(event) => setInviteForm((form) => ({ ...form, firstName: event.target.value }))} />
              <Input name="lastName" placeholder="Last name" value={inviteForm.lastName} onChange={(event) => setInviteForm((form) => ({ ...form, lastName: event.target.value }))} />
            </div>
            <Input name="phone" placeholder="Phone (optional)" value={inviteForm.phone} onChange={(event) => setInviteForm((form) => ({ ...form, phone: event.target.value }))} />
            {inviteError && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{inviteError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button type="button" aria-label="Send field user invite" disabled={inviteSubmitting} onClick={() => submitInvite()}>
              Send Invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
