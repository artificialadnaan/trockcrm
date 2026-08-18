import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  WeeklyReportProjectStatus,
  WeeklyReportStatus,
  WeeklyReportWeekState,
} from "@trock-crm/shared/types";

/** One expected cadence week, as the dashboard renders it. */
export interface WeeklyReportDashboardRow {
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperUserId: string | null;
  trockSuperName: string | null;
  weekOf: string;
  isCurrentWeek: boolean;
  state: WeeklyReportWeekState;
  daysLate: number;
  reportId: string | null;
  reportVersion: number | null;
  sentAt: string | null;
  sendError: string | null;
  /** When the mail provider accepted it. Null on a `sent` week means the client has not received it. */
  sendDeliveredAt: string | null;
  sendAttempts: number;
  /**
   * Derived on the SERVER, not here — an error left over from an attempt a retry then won is not a
   * failure, and neither is a null delivery on a send queued seconds ago. The CRM and the app must agree
   * on what the chip means, so neither of them decides it.
   */
  sendFailed: boolean;
  waitingOn: string | null;
  dismissalReason: string | null;
}

export interface WeeklyReportDashboardResponse {
  asOf: string;
  rows: WeeklyReportDashboardRow[];
  /** Outstanding weeks older than the lookback window, keyed by project id. Never silently dropped. */
  olderOutstandingCounts: Record<string, number>;
  lookbackWeeks: number;
}

export interface WeeklyReportClientContact {
  name: string | null;
  email: string | null;
}

export interface WeeklyReportProjectSummary {
  weeklyReportProjectId: string;
  reportsSent: number;
  lastSentAt: string | null;
  lastSentWeekOf: string | null;
  /** Null once reporting has stopped — paused, completed, or past the cadence end date. */
  nextDueWeekOf: string | null;
}

export interface WeeklyReportProject {
  id: string;
  dealId: string;
  dealName: string | null;
  dealNumber: string | null;
  projectNumber: string | null;
  propertyDisplayName: string | null;
  clientName: string | null;
  clientTeam: Record<"doc" | "pm" | "rm" | "cm", WeeklyReportClientContact>;
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperUserId: string | null;
  trockSuperName: string | null;
  contractDate: string | null;
  contractDateNote: string | null;
  projectStartDate: string | null;
  projectStartDateNote: string | null;
  projectCompletionDate: string | null;
  projectCompletionDateNote: string | null;
  projectedDurationWeeks: number | null;
  cadenceWeekday: number;
  cadenceStartDate: string;
  cadenceEndDate: string | null;
  status: WeeklyReportProjectStatus;
  createdAt: string;
  updatedAt: string;
  summary?: WeeklyReportProjectSummary | null;
}

export interface WeeklyReportPhoto {
  fileId: string;
  caption: string | null;
  originalDescription: string | null;
  sortOrder: number;
  takenAt: string | null;
  mimeType: string | null;
}

export interface WeeklyReportDetail {
  id: string;
  weeklyReportProjectId: string;
  dealId: string;
  weekOf: string;
  version: number;
  supersededById: string | null;
  status: WeeklyReportStatus;
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  completionPercent: number | null;
  weatherDelayDays: number | null;
  remainingWeeks: number | null;
  projectedDurationWeeks: number | null;
  authoredByName: string | null;
  authoredAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  sentAt: string | null;
  sendError: string | null;
  sendAttempts: number;
  sendDeliveredAt: string | null;
  sendLastAttemptAt: string | null;
  pdfAvailable: boolean;
  photos: WeeklyReportPhoto[];
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The "This Week" board.
 *
 * `asOf` is left to the SERVER by default. The office's business day, not the browser's, decides whether
 * a report is late — a director looking at a Dallas jobsite from another timezone would otherwise see a
 * week flip a day early.
 */
export function useWeeklyReportDashboard(options: { asOf?: string } = {}) {
  const [data, setData] = useState<WeeklyReportDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { asOf } = options;
  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
      setData(await api<WeeklyReportDashboardResponse>(`/weekly-reports/dashboard${query}`));
    } catch (err) {
      setError(errorMessage(err, "Couldn't load the weekly report board"));
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, rows: data?.rows ?? [], loading, error, refetch };
}

export function useWeeklyReportProjects(filters: { status?: string; search?: string } = {}) {
  const [projects, setProjects] = useState<WeeklyReportProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { status, search } = filters;
  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      const query = params.toString() ? `?${params.toString()}` : "";
      const response = await api<{ projects: WeeklyReportProject[] }>(`/weekly-reports/projects${query}`);
      setProjects(response.projects ?? []);
    } catch (err) {
      setError(errorMessage(err, "Couldn't load weekly report projects"));
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { projects, loading, error, refetch };
}

export function useWeeklyReportHistory(projectId: string | null) {
  const [reports, setReports] = useState<WeeklyReportDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!projectId) {
      setReports([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api<{ reports: WeeklyReportDetail[] }>(
        `/weekly-reports/reports?projectId=${encodeURIComponent(projectId)}`,
      );
      setReports(response.reports ?? []);
    } catch (err) {
      setError(errorMessage(err, "Couldn't load report history"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { reports, loading, error, refetch };
}

export function fetchWeeklyReportDetail(reportId: string) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}`);
}

export interface WeeklyReportProjectPayload {
  dealId?: string;
  propertyDisplayName?: string | null;
  clientName?: string | null;
  clientTeam?: Partial<Record<"doc" | "pm" | "rm" | "cm", Partial<WeeklyReportClientContact>>>;
  trockPmUserId?: string | null;
  trockSuperUserId?: string | null;
  contractDate?: string | null;
  contractDateNote?: string | null;
  projectStartDate?: string | null;
  projectStartDateNote?: string | null;
  projectCompletionDate?: string | null;
  projectCompletionDateNote?: string | null;
  projectedDurationWeeks?: number | null;
  cadenceWeekday?: number;
  cadenceStartDate?: string;
  cadenceEndDate?: string | null;
  status?: WeeklyReportProjectStatus;
}

export function createWeeklyReportProject(payload: WeeklyReportProjectPayload) {
  return api<WeeklyReportProject>("/weekly-reports/projects", { method: "POST", json: payload });
}

export function updateWeeklyReportProject(id: string, payload: WeeklyReportProjectPayload) {
  return api<WeeklyReportProject>(`/weekly-reports/projects/${id}`, { method: "PATCH", json: payload });
}

export function deleteWeeklyReportProject(id: string) {
  return api<void>(`/weekly-reports/projects/${id}`, { method: "DELETE" });
}

export function dismissWeeklyReportWeek(projectId: string, weekOf: string, reason: string) {
  return api<void>(`/weekly-reports/projects/${projectId}/dismiss`, {
    method: "POST",
    json: { weekOf, reason },
  });
}

export function transitionWeeklyReport(reportId: string, to: WeeklyReportStatus) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}/transition`, {
    method: "POST",
    json: { to },
  });
}

// --- Send ------------------------------------------------------------------------------------------

export interface WeeklyReportRecipientOption {
  role: string;
  name: string | null;
  email: string;
}

export interface WeeklyReportSenderContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The send modal, COMPOSED BY THE SERVER.
 *
 * Nothing in this shape is assembled on the client — not the subject, not the greeting, not the default
 * message. That is the whole reason the modal can be identical in the CRM and in T-Rock Cam without two
 * implementations of the recipient rules and the wording.
 */
export interface WeeklyReportSendDraft {
  reportId: string;
  weekOf: string;
  version: number;
  isCorrection: boolean;
  propertyName: string | null;
  recipients: string[];
  recipientOptions: WeeklyReportRecipientOption[];
  subject: string;
  greeting: string;
  contextParagraph: string;
  sender: WeeklyReportSenderContact;
  attachPdf: boolean;
  /** Null until the report is sent — the raw token exists exactly once, at send. */
  shareUrl: string | null;
  bodyPreview: string;
}

export interface WeeklyReportSendPayload {
  recipients: string[];
  subject: string;
  contextParagraph: string;
  attachPdf: boolean;
}

export function fetchWeeklyReportSendDraft(reportId: string) {
  return api<WeeklyReportSendDraft>(`/weekly-reports/reports/${reportId}/send-draft`);
}

export function sendWeeklyReport(reportId: string, payload: WeeklyReportSendPayload) {
  return api<{ report: WeeklyReportDetail; shareUrl: string }>(`/weekly-reports/reports/${reportId}/send`, {
    method: "POST",
    json: payload,
  });
}

export function retryWeeklyReportSend(reportId: string) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}/send/retry`, { method: "POST" });
}

/** Clone a sent report to the next version. It is NOT sent, and the original is not superseded yet. */
export function createWeeklyReportCorrection(reportId: string) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}/correction`, { method: "POST" });
}

export interface WeeklyReportAssignableUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

/**
 * Candidates for the PM / superintendent slots.
 *
 * These are `public.users` rows, which is what `trockPmUserId` / `trockSuperUserId` reference and what
 * the server compares against the acting user when deciding who may submit and who may approve. The
 * `field_responders` roster is a different table with different ids and would not authorise anyone.
 */
export function useWeeklyReportAssignableUsers() {
  const [users, setUsers] = useState<WeeklyReportAssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api<{ users: WeeklyReportAssignableUser[] }>("/weekly-reports/assignable-users");
        if (!cancelled) setUsers(response.users ?? []);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Couldn't load the project team roster"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { users, loading, error };
}

export interface WeeklyReportSettings {
  leadershipRecipientEmails: string[];
  updatedAt: string | null;
}

export function useWeeklyReportSettings() {
  const [settings, setSettings] = useState<WeeklyReportSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await api<WeeklyReportSettings>("/weekly-reports/settings"));
    } catch (err) {
      setError(errorMessage(err, "Couldn't load weekly report settings"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { settings, loading, error, refetch };
}

export function saveWeeklyReportSettings(leadershipRecipientEmails: string[]) {
  return api<WeeklyReportSettings>("/weekly-reports/settings", {
    method: "PUT",
    json: { leadershipRecipientEmails },
  });
}
