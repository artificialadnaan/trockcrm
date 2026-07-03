-- 0174_rfp_pending_sla_email_receipts.sql
--
-- Exactly-once ledger for the Pending RFP 24h SLA breach email (worker/src/jobs/rfp-pending-sla.ts).
--
-- WHY: an RFP that stays in the "Pending RFP" bucket (stage=opportunity, not bid-board-owned,
-- rfp_approval_status in pending_outbox/pending) longer than 24h should alert leadership. Unlike the
-- decline email (0148), an SLA breach is TIME-based, not a status transition, so no DB trigger fires it —
-- the worker runs an hourly cron scan instead. Scanning hourly means the same breach is seen many times, so
-- this ledger is the exactly-once guard, and the protocol is:
--   1. a single-flight Postgres advisory lock serializes runs cross-instance (no two scans race a send);
--   2. BEFORE sending, the scan INSERTs a CLAIM row (ON CONFLICT DO NOTHING) carrying a display snapshot
--      (deal_name/deal_number as first seen). The claim is NEVER deleted.
--   3. `sent_at` (nullable, no default) marks completion: it is set only AFTER a durable send. A crash
--      between claim and send, or a failed send, leaves sent_at NULL, so the next scan retries.
-- Because retries render the email from the STORED snapshot, a rename/renumber between attempts can't change
-- the payload — the same Resend idempotencyKey stays valid instead of being rejected as a key/payload mismatch.
--
-- CYCLE IDENTITY: keyed (tenant_schema, deal_id, rfp_approval_requested_at). rfp_approval_requested_at is
-- the instant the RFP entered pending; a re-triggered RFP gets a NEW requested_at -> a fresh cycle -> a new
-- alert (correct). This is a PUBLIC table (one row per office+deal+cycle), same shape as 0148's
-- rfp_rejection_email_receipts; no per-tenant copy is needed.
--
-- This ships with the WORKER (the hourly job) and is gated behind RFP_PENDING_SLA_ENABLED so it merges inert.

CREATE TABLE IF NOT EXISTS public.rfp_pending_sla_email_receipts (
  tenant_schema text NOT NULL,
  deal_id uuid NOT NULL,
  rfp_approval_requested_at timestamptz NOT NULL,
  -- Display snapshot captured at claim time so a retry after a rename renders an identical Resend payload.
  deal_name text,
  deal_number text,
  recipient_emails text,
  resend_message_id text,
  -- NULLABLE, no default: the row is a CLAIM at insert (sent_at NULL) and is stamped only after a durable
  -- send. A failed send leaves it NULL so the next scan retries.
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, deal_id, rfp_approval_requested_at)
);

CREATE INDEX IF NOT EXISTS rfp_pending_sla_email_receipts_deal_idx
  ON public.rfp_pending_sla_email_receipts (tenant_schema, deal_id);
