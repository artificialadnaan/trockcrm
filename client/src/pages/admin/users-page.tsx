import { useState } from "react";
import { RefreshCw, Shield } from "lucide-react";
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
  const { users, loading, error, refetch, updateUser } = useAdminUsers();
  const [updatingId, setUpdatingId] = useState<string | null>(null);

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Users"
        meta={`${activeUsers.length} active · ${inactiveUsers.length} inactive`}
        actions={{
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
              <TableHead>Extra Offices</TableHead>
              <TableHead>Status</TableHead>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => handleToggleActive(user.id, user.isActive)}
                    disabled={updatingId === user.id}
                  >
                    {user.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-gray-400 py-8">
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
        New users are auto-created on first Microsoft Entra SSO login. The admin assigns their
        role and office here after first login. In dev mode, use the user picker to test
        different roles.
      </div>
    </div>
  );
}
