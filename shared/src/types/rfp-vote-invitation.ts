/**
 * SyncHub-style project context snapshotted into the `rfp_vote_invitation` job payload at round-open (best-effort).
 * Shared between the server enqueue writer (rfp-enqueue) and the worker email builder (rfp-vote-invitation) so the
 * payload contract stays in sync across packages.
 */
export interface RfpVoteInvitationDealSummary {
  projectTypeLabel?: string | null;
  /** FORMATTED (canonical) project number — never the raw HubSpot id. */
  projectNumber?: string | null;
  amount?: number | null;
  companyName?: string | null;
  location?: string | null;
  estimator?: string | null;
  ownerName?: string | null;
  description?: string | null;
  /** ISO timestamp. */
  dueDate?: string | null;
}
