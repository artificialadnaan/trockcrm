import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  reportsTo?: string | null;
  officeName: string | null;
  isActive: boolean;
  extraOfficeCount: number;
  commissionRate?: number;
  rollingFloor?: number;
  overrideRate?: number;
  estimatedMarginRate?: number;
  minMarginPercent?: number;
  newCustomerShareFloor?: number;
  newCustomerWindowMonths?: number;
  commissionConfigActive?: boolean;
  sourceSystems: Array<"hubspot" | "procore">;
  localAuthStatus:
    | "not_invited"
    | "invite_sent"
    | "password_change_required"
    | "active"
    | "disabled";
  inviteSentAt: string | null;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  passwordChangedAt: string | null;
  revokedAt: string | null;
  latestLocalAuthEvent: {
    eventType: string;
    actorUserId: string | null;
    createdAt: string;
  } | null;
}

export interface LocalAuthEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface InvitePreview {
  recipientEmail: string;
  loginUrl: string;
  subject: string;
  html: string;
  text: string;
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

  const updateUsersBulk = async (ids: string[], input: Partial<AdminUser>) => {
    const results = await Promise.allSettled(
      ids.map((id) => api(`/admin/users/${id}`, {
        method: "PATCH",
        json: input,
      }))
    );
    await load();

    const failedCount = results.filter((result) => result.status === "rejected").length;
    if (failedCount > 0) {
      throw new Error(`Updated ${ids.length - failedCount} users, but ${failedCount} failed`);
    }
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

  const previewInvite = async (userId: string) => {
    const response = await api<{ preview: InvitePreview }>(`/admin/users/${userId}/preview-invite`, {
      method: "POST",
    });
    return response.preview;
  };

  const revokeInvite = async (userId: string) => {
    await api(`/admin/users/${userId}/revoke-invite`, {
      method: "POST",
    });
    await load();
  };

  const getLocalAuthEvents = async (userId: string) => {
    const response = await api<{ events: LocalAuthEvent[] }>(`/admin/users/${userId}/local-auth-events`);
    return response.events;
  };

  useEffect(() => { load(); }, []);
  return {
    users,
    loading,
    error,
    refetch: load,
    updateUser,
    updateUsersBulk,
    grantAccess,
    revokeAccess,
    importExternalUsers,
    sendInvite,
    previewInvite,
    revokeInvite,
    getLocalAuthEvents,
  };
}
