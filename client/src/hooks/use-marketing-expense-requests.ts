import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
import type {
  MarketingExpenseApproverDecision,
  MarketingExpenseRequestDetail,
  MarketingExpenseRequestSummary,
  MarketingExpenseStatus,
} from "@trock-crm/shared/types";

/** Everything the approver queue can be filtered by. `draft` belongs to its author and is never listed. */
export type MarketingExpenseQueueStatus = Exclude<MarketingExpenseStatus, "draft">;

export interface MarketingExpenseRequestPayload {
  /** Browser-minted request id. Reusing it turns an ambiguous create retry into the original draft. */
  clientRequestId?: string;
  requestedByName: string;
  department: string;
  neededBy: string;
  vendorEvent: string;
  locationDates: string;
  purpose: string;
  expectedReturn: string;
  costAdvertising: string;
  costRegistration: string;
  costTravel: string;
  costLodging: string;
  costMeals: string;
  costMaterials: string;
  costOther1: string;
  costOther1Label: string;
  costOther2: string;
  costOther2Label: string;
  budgetJobCode: string;
  travelRequired: boolean;
  attendees: string;
  businessMeetings: string;
  paymentMethod: string | null;
  attachmentKinds: string[];
}

/** The submitter's own requests, drafts included — a draft whose submit failed must not be invisible. */
export function useMyMarketingExpenseRequests() {
  const [requests, setRequests] = useState<MarketingExpenseRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `api()` reads ?officeId from the URL at REQUEST time and turns it into the x-office-id header, which is
  // what selects the schema. Switching office keeps this route mounted, so without the scope in the
  // dependency list the page keeps showing the previous office's rows while every action fired from them
  // goes to the new tenant. The approver email links here WITH an ?officeId, so this is the ordinary path.
  const officeScopeId = useOfficeScopeId();
  /**
   * Which read is the current one.
   *
   * The dependency list answers "have I started a new read?"; it says nothing about "which read is this an
   * answer to". After an office switch both are in flight, and if the OLD one resolves second it overwrites
   * the new office's rows — the page then shows another tenant's data with no sign anything is wrong, and
   * every action fired from those rows is sent to the currently-scoped tenant. Identity is captured when
   * the request is issued and compared when it resolves; a loser touches no state at all, including
   * `loading`, so it cannot clear a latch the winner still owns.
   */
  const latestRequestId = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ requests: MarketingExpenseRequestSummary[] }>(
        "/marketing-expense-requests/mine",
      );
      if (requestId !== latestRequestId.current) return;
      setRequests(data.requests ?? []);
    } catch (err) {
      if (requestId !== latestRequestId.current) return;
      setError(err instanceof Error ? err.message : "Failed to load your expense requests");
    } finally {
      if (requestId === latestRequestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- officeScopeId is not read in the body; it is
    // read by api() from the URL. It is in the list to make the office switch RE-RUN this.
  }, [officeScopeId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { requests, loading, error, refetch };
}

/** The approver queue, one status at a time. */
export function useMarketingExpenseQueue(status: MarketingExpenseQueueStatus) {
  const [requests, setRequests] = useState<MarketingExpenseRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Same reason as above: the tenant scope lives in the URL, not in this closure.
  const officeScopeId = useOfficeScopeId();
  // Same race, and the queue has a second trigger for it: switching TABS re-issues too, so a slow
  // "pending" read can land after a fast "denied" one and repaint the wrong tab's rows.
  const latestRequestId = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ requests: MarketingExpenseRequestSummary[] }>(
        `/marketing-expense-requests?status=${encodeURIComponent(status)}`,
      );
      if (requestId !== latestRequestId.current) return;
      setRequests(data.requests ?? []);
    } catch (err) {
      if (requestId !== latestRequestId.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the expense request queue");
    } finally {
      if (requestId === latestRequestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: officeScopeId drives the re-read.
  }, [status, officeScopeId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { requests, loading, error, refetch };
}

/** Step 1 of the submit flow: create the DRAFT. Attachments upload against the id this returns. */
export async function createMarketingExpenseRequest(
  payload: MarketingExpenseRequestPayload,
): Promise<MarketingExpenseRequestDetail> {
  const data = await api<{ request: MarketingExpenseRequestDetail }>("/marketing-expense-requests", {
    method: "POST",
    json: payload,
  });
  return data.request;
}

/** Step 3: flip the draft to pending. This is what sends the emails — never the create. */
export async function submitMarketingExpenseRequest(
  id: string,
): Promise<MarketingExpenseRequestDetail> {
  const data = await api<{ request: MarketingExpenseRequestDetail }>(
    `/marketing-expense-requests/${encodeURIComponent(id)}/submit`,
    { method: "POST" },
  );
  return data.request;
}

export async function decideMarketingExpenseRequest(
  id: string,
  decision: MarketingExpenseApproverDecision,
  reason?: string,
): Promise<MarketingExpenseRequestDetail> {
  const data = await api<{ request: MarketingExpenseRequestDetail }>(
    `/marketing-expense-requests/${encodeURIComponent(id)}/decide`,
    { method: "POST", json: { decision, reason } },
  );
  return data.request;
}

export async function withdrawMarketingExpenseRequest(
  id: string,
): Promise<MarketingExpenseRequestDetail> {
  const data = await api<{ request: MarketingExpenseRequestDetail }>(
    `/marketing-expense-requests/${encodeURIComponent(id)}/withdraw`,
    { method: "POST" },
  );
  return data.request;
}

export async function getMarketingExpenseRequest(id: string): Promise<MarketingExpenseRequestDetail> {
  const data = await api<{ request: MarketingExpenseRequestDetail }>(
    `/marketing-expense-requests/${encodeURIComponent(id)}`,
  );
  return data.request;
}
