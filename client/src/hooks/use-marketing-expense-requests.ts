import { useCallback, useEffect, useState } from "react";
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

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ requests: MarketingExpenseRequestSummary[] }>(
        "/marketing-expense-requests/mine",
      );
      setRequests(data.requests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load your expense requests");
    } finally {
      setLoading(false);
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

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ requests: MarketingExpenseRequestSummary[] }>(
        `/marketing-expense-requests?status=${encodeURIComponent(status)}`,
      );
      setRequests(data.requests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the expense request queue");
    } finally {
      setLoading(false);
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
