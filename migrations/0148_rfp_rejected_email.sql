-- 0148_rfp_rejected_email.sql
--
-- Email the requesting rep + Takashi + Adam Shaw when a deal's RFP is DECLINED.
--
-- WHY: an RFP decline originates in SyncHub and relays to the CRM (POST /api/internal/rfp-declined,
-- signature-validated), which sets the deal's rfp_approval_status='declined' + rfp_declined_reason +
-- rfp_declined_at (server/src/modules/deals/rfp-decline-service.ts). The decline pipeline is live in
-- prod; the only missing piece is the notification off that transition. This trigger fires on the
-- pending->declined transition REGARDLESS of which path wrote it, so it catches the SyncHub relay (and
-- any future in-CRM decline) without coupling to the route code.
--
-- DESIGN INVARIANTS (mirrors migration 0147's structure/guards):
--   * DECLINE ONLY. Attached AFTER UPDATE OF rfp_approval_status, and the function enqueues only when
--     NEW.rfp_approval_status='declined' AND OLD is DISTINCT FROM 'declined'. Approval sets a different
--     value ('approved'), and an RFP *edit* (/rfp-edits) never touches rfp_approval_status — so neither
--     fires this. All gating lives IN THE FUNCTION (no WHEN clause), exactly like 0147, so the runtime
--     test exercises the real gating and inverting any guard breaks it (load-bearing).
--   * ONCE PER REJECTION CYCLE. The rejection cycle's identity is rfp_approval_request_id. The receipts
--     ledger (public.rfp_rejection_email_receipts, keyed (tenant_schema, deal_id, rfp_approval_request_id))
--     is the worker's exactly-once guard. A re-delivered/duplicate decline for the SAME request makes no
--     transition (OLD already 'declined') -> no enqueue. A genuine re-open issues a NEW request id, so a
--     later re-decline is a fresh transition with a new key -> emails again (correct, new cycle).
--   * BEST-EFFORT. A notification-path failure (job_queue outage, etc.) must NEVER roll back or block the
--     decline write that fired this trigger. The enqueue is wrapped so any error logs a WARNING and the
--     decline commits intact. Mirrors record_stage_history()/0147.
--   * NO AUDIT MARKER. Unlike 0147 (which needs a record_id-alone marker for "first entry ever"), the
--     rejection-cycle key is already carried by rfp_approval_request_id, and the decline itself is
--     already audited by rfp-decline-service.ts. So this needs no audit_log marker and no per-tenant
--     partial index — just the trigger + the receipts ledger.
--
-- This is a two-service deploy: the SERVER applies this migration (the trigger), the WORKER ships the
-- rfp_rejected_email handler. Both must redeploy.

CREATE OR REPLACE FUNCTION public.enqueue_rfp_rejected_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_number text;
  v_request_id integer;
  v_declined_reason text;
BEGIN
  -- Decline-only: act solely on the pending->declined transition. Approval ('approved') and RFP edits
  -- (which never write rfp_approval_status) are excluded. Defensive in-function gating (no WHEN clause),
  -- so the function self-guards regardless of how the trigger is attached.
  IF NEW.rfp_approval_status IS DISTINCT FROM 'declined' THEN
    RETURN NEW;
  END IF;
  IF OLD.rfp_approval_status IS NOT DISTINCT FROM 'declined' THEN
    -- Already declined (a re-delivered/duplicate decline for the same cycle) -> not a fresh rejection.
    RETURN NEW;
  END IF;

  -- The rejection cycle's identity. The receipts ledger and idempotencyKey are keyed on it, so without
  -- it there is no once-only guard to relay on. A genuine decline always carries it (the decline UPDATE
  -- in rfp-decline-service.ts matches on rfp_approval_request_id), so NULL here is a non-RFP-flow status
  -- write -> skip.
  v_request_id := NEW.rfp_approval_request_id;
  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_deal_number := NULLIF(BTRIM(NEW.deal_number), '');
  v_declined_reason := NULLIF(BTRIM(NEW.rfp_declined_reason), '');

  -- Bulk-script / migration escape hatch (mirrors app.skip_deal_opportunity_email on the 0147 trigger).
  IF lower(coalesce(current_setting('app.skip_rfp_rejected_email', true), '')) IN ('1', 'true', 'yes', 'on') THEN
    RETURN NEW;
  END IF;

  -- Best-effort from here: the notification is strictly secondary and must NEVER abort the decline write
  -- that fired this trigger. Mirrors 0147 — log a WARNING on failure and let the decline commit.
  BEGIN
    INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
    VALUES (
      'rfp_rejected_email',
      jsonb_build_object(
        'tenantSchema', TG_TABLE_SCHEMA,
        'dealId', NEW.id,
        'dealNumber', v_deal_number,
        'dealName', NEW.name,
        'declinedReason', v_declined_reason,
        'rfpApprovalRequestId', v_request_id,
        'requestedByUserId', NEW.rfp_approval_requested_by
      ),
      NULL,
      'pending',
      NOW()
    );
  EXCEPTION WHEN others THEN
    RAISE WARNING 'enqueue_rfp_rejected_email: notification enqueue failed for deal % (decline preserved): %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Sent-email receipt ledger (worker retry idempotency). Keyed (tenant_schema, deal_id,
-- rfp_approval_request_id) — the rejection cycle's identity — so each genuine rejection cycle sends
-- exactly once and a re-open + re-decline (new request id) is a fresh send. Independent table, like
-- 0147's receipts.
CREATE TABLE IF NOT EXISTS public.rfp_rejection_email_receipts (
  tenant_schema text NOT NULL,
  deal_id uuid NOT NULL,
  rfp_approval_request_id integer NOT NULL,
  deal_number text,
  recipient_emails text,
  resend_message_id text,
  sent_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, deal_id, rfp_approval_request_id)
);

CREATE INDEX IF NOT EXISTS rfp_rejection_email_receipts_deal_idx
  ON public.rfp_rejection_email_receipts (tenant_schema, deal_id);

-- Existing tenants: attach the trigger on each office_* deals table. No back-seed, no audit marker.
DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        DROP TRIGGER IF EXISTS deals_rfp_rejected_email_trg ON %I.deals;

        CREATE TRIGGER deals_rfp_rejected_email_trg
          AFTER UPDATE OF rfp_approval_status ON %I.deals
          FOR EACH ROW
          EXECUTE FUNCTION public.enqueue_rfp_rejected_email();
      $sql$,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS deals_rfp_rejected_email_trg ON office_dallas.deals;

CREATE TRIGGER deals_rfp_rejected_email_trg
  AFTER UPDATE OF rfp_approval_status ON office_dallas.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_rfp_rejected_email();
-- TENANT_SCHEMA_END
