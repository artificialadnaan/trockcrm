import { useState } from "react";
import { RefreshCw, Shield, MailPlus, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAdminUsers } from "@/hooks/use-admin-users";

export function UsersPage() {
  const {
    users,
    loading,
    error,
    refetch,
    updateUser,
    importExternalUsers,
    sendInvite,
  } = useAdminUsers();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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

  const activeUsers = users.filter((u) => u.isActive);
  const inactiveUsers = users.filter((u) => !u.isActive);

  const handleImport = async () => {
    setImporting(true);
    try {
      const summary = await importExternalUsers();
      toast.success(
        `Imported users: ${summary.createdCount} created, ${summary.matchedExistingCount} matched existing`
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Users"
        meta={`${activeUsers.length} active · ${inactiveUsers.length} inactive`}
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

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
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
            {users.map((user) => (
              <TableRow key={user.id} className={!user.isActive ? "opacity-50" : ""}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600">
                      {user.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium text-sm">{user.displayName}</div>
                      <div className="text-xs text-gray-500">{user.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-gray-600">
                  {user.officeName ?? "\u2014"}
                </TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    onValueChange={(v) => handleRoleChange(user.id, v as any)}
                    disabled={updatingId === user.id}
                  >
                    <SelectTrigger className="w-28 h-8 text-xs">
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
                    <Badge className="bg-blue-100 text-blue-800 text-xs">
                      +{user.extraOfficeCount} offices
                    </Badge>
                  ) : (
                    <span className="text-xs text-gray-400">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    className={
                      user.isActive
                        ? "bg-green-100 text-green-800 text-xs"
                        : "bg-gray-100 text-gray-500 text-xs"
                    }
                  >
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
                      className="text-xs h-7"
                      onClick={() => handleToggleActive(user.id, user.isActive)}
                      disabled={updatingId === user.id}
                    >
                      {user.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => handleSendInvite(user.id)}
                      disabled={updatingId === user.id || !user.isActive}
                    >
                      <MailPlus className="mr-1 h-3.5 w-3.5" />
                      {user.localAuthStatus === "not_invited" ? "Send invite" : "Resend invite"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                  No users found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
        <div className="flex items-center gap-2 font-medium mb-1">
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
