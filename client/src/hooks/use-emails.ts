import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Email {
  id: string;
  graphMessageId: string;
  graphConversationId: string | null;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[] | null;
  subject: string | null;
  bodyPreview: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  contactId: string | null;
  dealId: string | null;
  userId: string;
  sentAt: string;
  syncedAt: string;
}

export interface EmailThreadBinding {
  id: string;
  mailboxAccountId: string;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  propertyId: string | null;
  propertyName: string | null;
  leadId: string | null;
  leadName: string | null;
  dealId: string | null;
  dealName: string | null;
  projectId: string | null;
  projectName: string | null;
  confidence: "high" | "medium" | "low";
  assignmentReason: string | null;
}

export interface EmailThreadPreview {
  affectedMessageCount?: number;
  existingDealId?: string | null;
  nextDealId?: string | null;
}

export interface EmailThread {
  binding: EmailThreadBinding | null;
  preview: EmailThreadPreview | null;
  emails: Email[];
}

export interface EmailFilters {
  direction?: "inbound" | "outbound";
  search?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useUserEmails(filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useDealEmails(dealId: string | undefined, filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email/deal/${dealId}${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal emails");
    } finally {
      setLoading(false);
    }
  }, [dealId, filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useContactEmails(contactId: string | undefined, filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email/contact/${contactId}${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contact emails");
    } finally {
      setLoading(false);
    }
  }, [contactId, filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useEmailThread(conversationId: string | undefined) {
  const [thread, setThread] = useState<EmailThread>({ binding: null, preview: null, emails: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchThread = useCallback(async () => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<EmailThread>(
        `/email/thread/${encodeURIComponent(conversationId)}`
      );
      setThread(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load thread");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  return { thread, loading, error, refetch: fetchThread, setThread };
}

// --- Mutation Functions ---

export async function sendEmail(input: {
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml: string;
  dealId?: string;
  contactId?: string;
}) {
  return api<{ email: Email }>("/email/send", {
    method: "POST",
    json: input,
  });
}

export async function associateEmailToDeal(emailId: string, dealId: string) {
  return api<{ success: boolean }>(`/email/${emailId}/associate`, {
    method: "POST",
    json: { dealId },
  });
}

export async function assignEmailThread(conversationId: string, dealId: string) {
  return api<{ success: boolean; bindingId: string; thread: EmailThread }>(
    `/email/thread/${encodeURIComponent(conversationId)}/assign`,
    {
      method: "POST",
      json: { dealId },
    }
  );
}

export async function reassignEmailThread(conversationId: string, dealId: string) {
  return api<{ success: boolean; bindingId: string; preview: EmailThreadPreview | null; thread: EmailThread }>(
    `/email/thread/${encodeURIComponent(conversationId)}/reassign`,
    {
      method: "POST",
      json: { dealId },
    }
  );
}

export async function detachEmailThread(conversationId: string) {
  return api<{ success: boolean; thread: EmailThread }>(
    `/email/thread/${encodeURIComponent(conversationId)}/detach`,
    {
      method: "POST",
    }
  );
}
