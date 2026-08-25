import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
import type { CrmAssignableRole, UserRole } from "@trock-crm/shared/types";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep" | "construction";
  /**
   * The role this user has in the currently selected office, or null when they cannot access it.
   *
   * `role` deliberately stays their home/base role because the Users page is global-admin management.
   * Office-scoped controls, such as notification recipients, must use this field for eligibility instead.
   */
  effectiveRole?: UserRole | null;
  officeId: string;
  reportsTo?: string | null;
  officeName: string | null;
  isActive: boolean;
  /** Is this person expected to carry deals? Decides whether they appear on the DIRECTOR DASHBOARD
   *  rosters (migration 0219). Independent of `role`, which decides what they may see and do — an
   *  estimator can hold role='rep' for CRM access without ever selling, and a director can sell. */
  generatesSales: boolean;
  /** Does this person estimate jobs? Decides whether they appear in the ESTIMATORS section of the deals
   *  dashboard rep filter (migration 0222). Independent of `generatesSales`, but the roster lists each
   *  person exactly once and SALES WINS: someone with both flags stays under Sales. */
  estimatesJobs: boolean;
  extraOfficeCount: number;
  commissionRate?: number;
  commissionStructure?: "solo" | "mixed";
  capxRateSolo?: number;
  capxRateMixed?: number;
  serviceSourceRate?: number;
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
  const officeScopeId = useOfficeScopeId();
  /**
   * The endpoint's `effectiveRole` is evaluated in the office selected by `?officeId`; it is not an
   * attribute of the person. Keep the data's scope beside it so a URL switch cannot briefly offer an
   * approver under their previous office role while the next request is in flight.
   */
  const [loadedOfficeScopeId, setLoadedOfficeScopeId] = useState<string | null | undefined>(undefined);
  const currentOfficeScopeId = useRef(officeScopeId);
  const latestRequestId = useRef(0);
  currentOfficeScopeId.current = officeScopeId;

  const load = useCallback(async () => {
    const requestScopeId = officeScopeId;
    // A mutation handler can retain the previous render's `load`. Do not let it issue a request with the
    // new URL header but label its response as the old scope (or invalidate the new scope's request).
    if (currentOfficeScopeId.current !== requestScopeId) return;
    const requestId = ++latestRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ users: AdminUser[] }>("/admin/users");
      if (requestId !== latestRequestId.current || currentOfficeScopeId.current !== requestScopeId) return;
      setUsers(data.users);
      setLoadedOfficeScopeId(requestScopeId);
    } catch {
      if (requestId !== latestRequestId.current || currentOfficeScopeId.current !== requestScopeId) return;
      // Do not relabel the previous office's people as an empty current-office result after an error.
      setUsers([]);
      setLoadedOfficeScopeId(requestScopeId);
      setError("Failed to load users");
    } finally {
      if (requestId === latestRequestId.current && currentOfficeScopeId.current === requestScopeId) {
        setLoading(false);
      }
    }
  }, [officeScopeId]);

  const updateUser = async (id: string, input: Partial<AdminUser>) => {
    await api(`/admin/users/${id}`, {
      method: "PATCH",
      json: input,
    });
    await load();
  };

  const createUser = async (input: {
    email: string;
    displayName: string;
    firstName?: string;
    lastName?: string;
    role: CrmAssignableRole;
    officeId: string;
    sendInvite?: boolean;
  }) => {
    return api<{ user: AdminUser; invite: { sent: boolean; error?: string } }>("/admin/users", {
      method: "POST",
      json: input,
    });
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

  useEffect(() => {
    void load();
    // A late response must not overwrite either another office or an unmounted page.
    return () => {
      latestRequestId.current += 1;
    };
  }, [load]);

  const hasCurrentOfficeUsers = loadedOfficeScopeId === officeScopeId;
  return {
    // Until this office has answered, hiding the previous office's roles is safer than drawing a picker
    // that can submit them into the newly selected tenant.
    users: hasCurrentOfficeUsers ? users : [],
    loading: loading || !hasCurrentOfficeUsers,
    error: hasCurrentOfficeUsers ? error : null,
    refetch: load,
    updateUser,
    createUser,
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
