-- 0174_rfp_pending_sla_email_receipts.sql
--
-- Exactly-once ledger for the Pending RFP 24h SLA breach email (worker/src/jobs/rfp-pending-sla.ts).
--
-- WHY: an RFP that stays in the "Pending RFP" bucket (stage=opportunity, not bid-board-owned,
-- rfp_approval_status in pending_outbox/pending) longer than 24h should alert leadership. Unlike the
-- decline email (0148), an SLA breach is TIME-based, not a status transition, so no DB trigger fires it —
-- the worker runs an hourly cron scan instead. Scanning hourly means the same breach is seen many times, so
-- this ledger is the exactly-once guard: the scan INSERTs a claim row ON CONFLICT DO NOTHING BEFORE sending,
-- and a send failure DELETEs the claim so the next scan retries.
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
  deal_number text,
  recipient_emails text,
  resend_message_id text,
  sent_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, deal_id, rfp_approval_requested_at)
);

CREATE INDEX IF NOT EXISTS rfp_pending_sla_email_receipts_deal_idx
  ON public.rfp_pending_sla_email_receipts (tenant_schema, deal_id);
