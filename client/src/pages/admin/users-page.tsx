import { useEffect, useState } from "react";
import {
  Download,
  MailPlus,
  RefreshCw,
  Search,
  Shield,
  UserCheck,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAdminUsers } from "@/hooks/use-admin-users";
import {
  buildUsersSummary,
  filterUsers,
  pruneSelection,
  type UserActivityFilter,
  type UserAuthFilter,
  type UserRoleFilter,
  type UserSourceFilter,
} from "./users-page.helpers";

export function UsersPage() {
  const {
    users,
    loading,
    error,
    refetch,
    updateUser,
    updateUsersBulk,
    importExternalUsers,
    sendInvite,
  } = useAdminUsers();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRoleFilter>("all");
  const [activityFilter, setActivityFilter] = useState<UserActivityFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<UserSourceFilter>("all");
  const [authFilter, setAuthFilter] = useState<UserAuthFilter>("all");

  const sourceLabel: Record<"hubspot" | "procore", string> = {
    hubspot: "HubSpot",
    procore: "Procore",
  };

  const localAuthLabel = {
    not_invited: "Not invited",
    invite_sent: "Invite sent",
    password_change_required: "Password change required",
    active: "Active local auth",
    disabled: "Disabled",
  } as const;

  const summary = buildUsersSummary(users);
  const filteredUsers = filterUsers(users, {
    query,
    role: roleFilter,
    source: sourceFilter,
    activity: activityFilter,
    auth: authFilter,
  });
  const filteredSummary = buildUsersSummary(filteredUsers);
  const visibleUserIds = filteredUsers.map((user) => user.id);
  const visibleSelectionKey = visibleUserIds.join("|");
  const selectedVisibleCount = visibleUserIds.filter((id) => selectedUserIds.includes(id)).length;
  const allVisibleSelected = visibleUserIds.length > 0 && selectedVisibleCount === visibleUserIds.length;

  useEffect(() => {
    setSelectedUserIds((current) => {
      const next = pruneSelection(current, visibleUserIds);
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current;
      }
      return next;
    });
  }, [query, roleFilter, activityFilter, sourceFilter, authFilter, visibleSelectionKey]);

  const handleRoleChange = async (userId: string, role: "admin" | "director" | "rep") => {
    setUpdatingId(userId);
    try {
      await updateUser(userId, { role });
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleActive = async (userId: string, isActive: boolean) => {
    setUpdatingId(userId);
    try {
      await updateUser(userId, { isActive: !isActive });
    } finally {
      setUpdatingId(null);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const importSummary = await importExternalUsers();
      toast.success(
        `Imported users: ${importSummary.createdCount} created, ${importSummary.matchedExistingCount} matched existing`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleSendInvite = async (userId: string) => {
    setUpdatingId(userId);
    try {
      await sendInvite(userId);
      toast.success("Invite sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setUpdatingId(null);
    }
  };

  const toggleSelectedUser = (userId: string, checked: boolean) => {
    setSelectedUserIds((current) => {
      if (checked) return current.includes(userId) ? current : [...current, userId];
      return current.filter((id) => id !== userId);
    });
  };

  const toggleSelectVisible = (checked: boolean) => {
    setSelectedUserIds((current) => {
      if (!checked) return current.filter((id) => !visibleUserIds.includes(id));
      return Array.from(new Set([...current, ...visibleUserIds]));
    });
  };

  const clearFilters = () => {
    setQuery("");
    setRoleFilter("all");
    setActivityFilter("all");
    setSourceFilter("all");
    setAuthFilter("all");
  };

  const clearSelection = () => setSelectedUserIds([]);

  const handleBulkUpdate = async (
    input: Partial<{ role: "admin" | "director" | "rep"; isActive: boolean }>,
    successMessage: string,
  ) => {
    if (selectedUserIds.length === 0) return;

    setBulkUpdating(true);
    try {
      await updateUsersBulk(selectedUserIds, input);
      toast.success(successMessage);
      setSelectedUserIds([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBulkUpdating(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Users"
        meta={`${summary.active} active · ${summary.inactive} inactive`}
        actions={{
          primary: (
            <Button variant="outline" size="sm" onClick={handleImport} disabled={importing || loading}>
              <Download className={`mr-1 h-4 w-4 ${importing ? "animate-pulse" : ""}`} />
              {importing ? "Importing..." : "Import Procore + HubSpot"}
            </Button>
          ),
          secondaryAction: (
            <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
              <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          ),
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Loaded</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</p>
            </div>
            <UsersRound className="h-5 w-5 text-slate-400" />
          </div>
          <p className="mt-2 text-xs text-slate-500">{filteredSummary.total} matching current filters</p>
        </div>

        <div className="rounded-xl border bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Roles</p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {summary.reps} reps · {summary.directors} directors · {summary.admins} admins
              </p>
            </div>
            <UserCog className="h-5 w-5 text-slate-400" />
          </div>
          <p className="mt-2 text-xs text-slate-500">Bulk role changes only affect selected users.</p>
        </div>

        <div className="rounded-xl border bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Invites Pending</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.notInvited}</p>
            </div>
            <MailPlus className="h-5 w-5 text-slate-400" />
          </div>
          <p className="mt-2 text-xs text-slate-500">No bulk invite action is exposed here.</p>
        </div>

        <div className="rounded-xl border bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Selected</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{selectedUserIds.length}</p>
            </div>
            <UserCheck className="h-5 w-5 text-slate-400" />
          </div>
          <p className="mt-2 text-xs text-slate-500">{selectedVisibleCount} selected in the current view.</p>
        </div>
      </div>

      <div className="rounded-xl border bg-white p-4 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex-1 space-y-1">
            <label htmlFor="user-search" className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
              Search
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                id="user-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or email"
                className="h-9 pl-8"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Role</label>
              <Select value={roleFilter} onValueChange={(value) => setRoleFilter(value as UserRoleFilter)}>
                <SelectTrigger className="h-9 min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="rep">Rep</SelectItem>
                  <SelectItem value="director">Director</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Status</label>
              <Select value={activityFilter} onValueChange={(value) => setActivityFilter(value as UserActivityFilter)}>
                <SelectTrigger className="h-9 min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Source</label>
              <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as UserSourceFilter)}>
                <SelectTrigger className="h-9 min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="hubspot">HubSpot</SelectItem>
                  <SelectItem value="procore">Procore</SelectItem>
                  <SelectItem value="multi">Multi-source</SelectItem>
                  <SelectItem value="none">No source</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Login</label>
              <Select value={authFilter} onValueChange={(value) => setAuthFilter(value as UserAuthFilter)}>
                <SelectTrigger className="h-9 min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All login states</SelectItem>
                  <SelectItem value="not_invited">Not invited</SelectItem>
                  <SelectItem value="invite_sent">Invite sent</SelectItem>
                  <SelectItem value="password_change_required">Password change required</SelectItem>
                  <SelectItem value="active">Active local auth</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{filteredSummary.total} matching</Badge>
          <Badge variant="outline">{filteredSummary.active} active</Badge>
          <Badge variant="outline">{filteredSummary.inactive} inactive</Badge>
          <Badge variant="outline">{filteredSummary.reps} reps</Badge>
          <Badge variant="outline">{filteredSummary.directors} directors</Badge>
          <Badge variant="outline">{filteredSummary.admins} admins</Badge>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={clearFilters}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear filters
          </Button>
        </div>
      </div>

      {selectedUserIds.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm font-medium text-slate-900">{selectedUserIds.length} users selected</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkUpdate({ role: "rep" }, "Updated selected users to rep")}
                disabled={bulkUpdating}
              >
                Make rep
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkUpdate({ role: "director" }, "Updated selected users to director")}
                disabled={bulkUpdating}
              >
                Make director
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkUpdate({ role: "admin" }, "Updated selected users to admin")}
                disabled={bulkUpdating}
              >
                Make admin
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkUpdate({ isActive: true }, "Activated selected users")}
                disabled={bulkUpdating}
              >
                Activate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkUpdate({ isActive: false }, "Deactivated selected users")}
                disabled={bulkUpdating}
              >
                Deactivate
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkUpdating}>
                Clear selection
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={toggleSelectVisible}
                  disabled={filteredUsers.length === 0 || bulkUpdating}
                />
              </TableHead>
              <TableHead>User</TableHead>
              <TableHead>Primary Office</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Sources</TableHead>
              <TableHead>Extra Offices</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Login</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.map((user) => (
              <TableRow key={user.id} className={!user.isActive ? "opacity-50" : ""}>
                <TableCell>
                  <Checkbox
                    checked={selectedUserIds.includes(user.id)}
                    onCheckedChange={(checked) => toggleSelectedUser(user.id, checked)}
                    disabled={bulkUpdating}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600">
                      {user.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{user.displayName}</div>
                      <div className="text-xs text-gray-500">{user.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-gray-600">{user.officeName ?? "\u2014"}</TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    onValueChange={(value) => handleRoleChange(user.id, value as "admin" | "director" | "rep")}
                    disabled={updatingId === user.id || bulkUpdating}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="director">Director</SelectItem>
                      <SelectItem value="rep">Rep</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {user.sourceSystems.length > 0 ? user.sourceSystems.map((source) => (
                      <Badge key={source} variant="outline" className="text-xs">
                        {sourceLabel[source]}
                      </Badge>
                    )) : (
                      <span className="text-xs text-gray-400">{"\u2014"}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {user.extraOfficeCount > 0 ? (
                    <Badge className="bg-blue-100 text-xs text-blue-800">
                      +{user.extraOfficeCount} offices
                    </Badge>
                  ) : (
                    <span className="text-xs text-gray-400">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge className={user.isActive ? "bg-green-100 text-xs text-green-800" : "bg-gray-100 text-xs text-gray-500"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {localAuthLabel[user.localAuthStatus]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleToggleActive(user.id, user.isActive)}
                      disabled={updatingId === user.id || bulkUpdating}
                    >
                      {user.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleSendInvite(user.id)}
                      disabled={updatingId === user.id || bulkUpdating || !user.isActive}
                    >
                      <MailPlus className="mr-1 h-3.5 w-3.5" />
                      {user.localAuthStatus === "not_invited" ? "Send invite" : "Resend invite"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}

            {filteredUsers.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-gray-400">
                  No users match the current filters
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Shield className="h-4 w-4" />
          User provisioning
        </div>
        Use the import action to seed the union of Procore users and HubSpot owners into Dallas.
        Send invites only when you are ready to hand out temporary local-password access. Existing
        role and office assignments are preserved for CRM users that already exist.
      </div>
    </div>
  );
}
