import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  officeName: string | null;
  isActive: boolean;
  extraOfficeCount: number;
  sourceSystems: Array<"hubspot" | "procore">;
  localAuthStatus:
    | "not_invited"
    | "invite_sent"
    | "password_change_required"
    | "active"
    | "disabled";
}

export interface ImportedUsersSummary {
  scannedCount: number;
  createdCount: number;
  matchedExistingCount: number;
  skippedCount: number;
  warnings: string[];
}

export function useAdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ users: AdminUser[] }>("/admin/users");
      setUsers(data.users);
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  const updateUser = async (id: string, input: Partial<AdminUser>) => {
    await api(`/admin/users/${id}`, {
      method: "PATCH",
      json: input,
    });
    await load();
  };

  const grantAccess = async (userId: string, officeId: string, roleOverride?: string) => {
    await api(`/admin/users/${userId}/office-access`, {
      method: "POST",
      json: { officeId, roleOverride },
    });
    await load();
  };

  const revokeAccess = async (userId: string, officeId: string) => {
    await api(`/admin/users/${userId}/office-access/${officeId}`, {
      method: "DELETE",
    });
    await load();
  };

  const importExternalUsers = async () => {
    const summary = await api<ImportedUsersSummary>("/admin/users/import-external", {
      method: "POST",
    });
    await load();
    return summary;
  };

  const sendInvite = async (userId: string) => {
    await api(`/admin/users/${userId}/send-invite`, {
      method: "POST",
    });
    await load();
  };

  useEffect(() => { load(); }, []);
  return {
    users,
    loading,
    error,
    refetch: load,
    updateUser,
    grantAccess,
    revokeAccess,
    importExternalUsers,
    sendInvite,
  };
}
