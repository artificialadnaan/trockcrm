import { useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * When the mail provider ACCEPTED it. Null on a `sent` week means it has not got that far.
   *
   * Not proof anyone received anything, and never was: a mistyped domain is accepted and then hard-bounces
   * and this field still reads like a report that landed. What the provider said afterwards is
   * `sendDeliveryStatus`; the two are separate fields on purpose.
   */
  sendDeliveredAt: string | null;
  /**
   * The provider's later verdict, from its delivery webhook:
   * `delayed | delivered | complained | failed | bounced`, or null while nothing has spoken for the send.
   * Null is "unknown", not "fine".
   */
  sendDeliveryStatus: string | null;
  sendAttempts: number;
  /**
   * All three derived on the SERVER, not here — an error left over from an attempt a retry then won is
   * not a failure, and neither is a null delivery on a send queued seconds ago. The CRM and the app must
   * agree on what the chip means, so neither of them decides it.
   */
  sendFailed: boolean;
  /** Undelivered, no error recorded, and too old to still be in flight — the silent failure. */
  sendStalled: boolean;
  /** Undelivered and still plausibly on its way. */
  sendPending: boolean;
  /**
   * The provider told us the client did NOT receive it — and the three flags above are all FALSE for it.
   *
   * They are keyed on an absent delivery stamp; a bounced report has one, because the provider accepted
   * the message before the receiving server refused it. Without this flag a bounce renders as an ordinary
   * delivered week.
   */
  sendBounced: boolean;
  /** Which report a Retry addresses — NOT always `reportId`, once a correction has been drafted over it. */
  sendRetryReportId: string | null;
  /** When THAT send was committed. `sentAt` is the live row's, which is null once a correction exists. */
  sendRetrySentAt: string | null;
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
  /** Reports whose email the provider ACCEPTED — a committed send that never got out is not one. */
  reportsSent: number;
  lastSentAt: string | null;
  lastSentWeekOf: string | null;
  /** Sends this project committed that never reached the provider. Shown so narrowing the count above
   *  does not simply make a lost report disappear from both numbers. */
  undeliveredSends: number;
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
  /** The field-team roster row holding the slot. Null on setups made before the roster link existed. */
  trockPmResponderId: string | null;
  /** The CRM login that person signs in with, or null when they hold none. Decides who may approve/send. */
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperResponderId: string | null;
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
  /** The provider ACCEPTED the message. Not delivery — see `sendDeliveryStatus`. */
  sendDeliveredAt: string | null;
  /** `delayed | delivered | complained | failed | bounced`, once the delivery webhook has spoken. */
  sendDeliveryStatus: string | null;
  sendDeliveryStatusAt: string | null;
  /** `{ eventType, emailId, bounceClass, bounceType, bounceSubType, message }`, as the provider gave it. */
  sendDeliveryDetail: Record<string, unknown> | null;
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
  trockPmResponderId?: string | null;
  trockSuperResponderId?: string | null;
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

/**
 * Queue the same message again.
 *
 * `acknowledgeDuplicateRisk` is only set once the caller has told the PM, in words, that the mail
 * provider's 24-hour idempotency window has closed and a replay is now a genuinely second email. The
 * server refuses without it rather than trusting the UI to have asked.
 */
export function retryWeeklyReportSend(reportId: string, acknowledgeDuplicateRisk = false) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}/send/retry`, {
    method: "POST",
    json: { acknowledgeDuplicateRisk },
  });
}

/** Clone a sent report to the next version. It is NOT sent, and the original is not superseded yet. */
export function createWeeklyReportCorrection(reportId: string) {
  return api<WeeklyReportDetail>(`/weekly-reports/reports/${reportId}/correction`, { method: "POST" });
}

/** One thing that happened to a report, in the order it happened. Built on the SERVER, not here. */
export interface WeeklyReportAuditEvent {
  type:
    | "drafted"
    | "submitted"
    | "approved"
    | "sent"
    | "accepted"
    | "delivered"
    | "delayed"
    | "failed"
    | "retried"
    | "alerted"
    | "superseded";
  at: string;
  actorName: string | null;
  detail: string | null;
}

export interface WeeklyReportAuditReport {
  id: string;
  weekOf: string;
  version: number;
  status: string;
  supersededById: string | null;
  recipients: string[] | null;
  deliveryStatus: string | null;
  /** The CRM has no evidence the client received this one. A bounce counts — see the server's note. */
  undelivered: boolean;
  /**
   * A delivery problem somebody still has to act on. Decided by the server, and the audit dialog's
   * count, chip and border all read THIS rather than each deriving their own — see the server's note
   * on why. Broader than `undelivered`: it also covers a correction that replaced a failure and has
   * not been confirmed.
   */
  outstanding: boolean;
  events: WeeklyReportAuditEvent[];
}

export interface WeeklyReportProjectAudit {
  project: WeeklyReportProject;
  reports: WeeklyReportAuditReport[];
  reminders: { weekOf: string; kind: string; at: string }[];
  dismissals: { weekOf: string; reason: string | null; actorName: string | null; at: string }[];
  pauses: {
    pausedFrom: string;
    resumedOn: string | null;
    pausedByName: string | null;
    resumedByName: string | null;
  }[];
}

/** The whole life of one project's reporting. Fetched only when the drill-in is actually opened. */
export function useWeeklyReportProjectAudit(projectId: string | null) {
  const [data, setData] = useState<WeeklyReportProjectAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const audit = await api<WeeklyReportProjectAudit>(`/weekly-reports/projects/${projectId}/audit`);
        if (!cancelled) setData(audit);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Couldn't load this project's history"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { audit: data, loading, error };
}

/** A Won job that can still be given a cadence, as the project picker lists it. */
export interface WeeklyReportEligibleDeal {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  /** The company the work is being done for — seeds the Client field on pick. */
  clientName: string | null;
  /** Seeds the Contract date field on pick. Null on the Won jobs that carry no signed date. */
  contractSignedDate: string | null;
}

/**
 * Search the project picker's feed.
 *
 * Deliberately NOT `useDeals`. That searches every active deal — the picker used to offer all 1,445 of
 * them, and the server refused the ~970 that are not Won with a 400 only after the form had been filled
 * in. This endpoint applies the same Won predicate the write path enforces, drops jobs that already have
 * a setup, and returns the client company and contract date so picking one seeds those fields.
 *
 * A sequence guard drops out-of-order responses: a slow early keystroke must not overwrite the results
 * for what the user has actually typed.
 */
export function useWeeklyReportEligibleDeals(search: string, enabled: boolean) {
  const [deals, setDeals] = useState<WeeklyReportEligibleDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      // Bump the sequence too, not just the state: an earlier request still in flight would otherwise
      // resolve after this and repopulate a picker that is no longer showing.
      seq.current += 1;
      setDeals([]);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    (async () => {
      try {
        const response = await api<{ deals: WeeklyReportEligibleDeal[] }>(
          `/weekly-reports/eligible-deals?search=${encodeURIComponent(search)}&limit=20`,
        );
        if (mine === seq.current) setDeals(response.deals ?? []);
      } catch {
        if (mine === seq.current) setDeals([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    })();
  }, [search, enabled]);

  return { deals, loading };
}

export interface WeeklyReportAssignableUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

/** One selectable member of the office's field team, as the PM / superintendent pickers render them. */
export interface WeeklyReportAssignableResponder {
  /** `field_responders.id` — what the form submits as `trockPmResponderId` / `trockSuperResponderId`. */
  id: string;
  name: string;
  email: string;
  role: "superintendent" | "project_manager";
  /**
   * Whether this person holds a CRM login and can therefore approve and send from the phone. False for
   * field staff who never needed an account — they still own the slot, print on the report and get the
   * reminder emails; a director approves on their behalf. The form says so at the point of choosing.
   */
  hasLogin: boolean;
}

/**
 * Candidates for the PM / superintendent slots — the office's FIELD TEAM ROSTER.
 *
 * The same list the deal Team tab and the QC scorecards pick from. It replaced a feed of `public.users`
 * filtered to four broad roles, which against the live roster could offer six of fifteen people: four are
 * `rep` logins who are genuinely PMs and superintendents, and five hold no CRM account at all.
 *
 * `users` is still returned by the endpoint and still typed here, but nothing renders it any more. It is
 * kept so a browser running the previous bundle through a deploy keeps working rather than showing an
 * empty picker.
 */
export function useWeeklyReportAssignableUsers() {
  const [users, setUsers] = useState<WeeklyReportAssignableUser[]>([]);
  const [responders, setResponders] = useState<WeeklyReportAssignableResponder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api<{
          users: WeeklyReportAssignableUser[];
          responders?: WeeklyReportAssignableResponder[];
        }>("/weekly-reports/assignable-users");
        if (!cancelled) {
          setUsers(response.users ?? []);
          setResponders(response.responders ?? []);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Couldn't load the field team roster"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { users, responders, loading, error };
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
