import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface LeadDueDiligenceApproval {
  id: string;
  lead_id: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  detection_signal: Record<string, unknown>;
  email_sent_at: string | null;
  email_message_id: string | null;
  lead_name: string;
  company_name: string;
  company_verification_status: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_role: string | null;
  primary_contact_role_other_label: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  unit_count: number | null;
  build_year: number | null;
  project_type_name: string | null;
  budget_status: string | null;
  bid_due_date: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
}

export interface NotificationRecipient {
  userId: string;
  email: string;
  displayName: string;
}

export function useLeadDueDiligenceApprovals(status: "pending" | "approved" | "rejected" = "pending") {
  const [approvals, setApprovals] = useState<LeadDueDiligenceApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refetch() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ approvals: LeadDueDiligenceApproval[] }>(
        `/admin/lead-due-diligence-approvals?status=${status}`
      );
      setApprovals(data.approvals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refetch();
  }, [status]);

  return { approvals, loading, error, refetch };
}

export function approveLeadDueDiligenceApproval(id: string) {
  return api<{ approval: unknown }>(`/admin/lead-due-diligence-approvals/${id}/approve`, {
    method: "POST",
  });
}

export function rejectLeadDueDiligenceApproval(id: string, reason: string) {
  return api<{ approval: unknown }>(`/admin/lead-due-diligence-approvals/${id}/reject`, {
    method: "POST",
    json: { reason },
  });
}

export async function getNotificationRecipientGroup(key: string) {
  return api<{
    group: { id: string; key: string; name: string; description: string | null };
    recipients: NotificationRecipient[];
  }>(`/admin/notification-recipient-groups/${key}`);
}

export async function updateNotificationRecipientGroup(key: string, userIds: string[]) {
  return api<{
    group: { id: string; key: string; name: string; description: string | null };
    recipients: NotificationRecipient[];
  }>(`/admin/notification-recipient-groups/${key}/assignments`, {
    method: "PUT",
    json: { userIds },
  });
}
