-- 0154_rfp_reconfirm_denial_email.sql
--
-- Email the requesting rep + leadership when a reviewer RE-CONFIRMS a declined RFP in the override-review
-- gate (rfp_override_decision -> 'denial_reconfirmed').
--
-- WHY: an RFP decline (migration 0148) emails the rep + leadership and points reviewers (Takashi/Adam) at
-- the override-review page, where they either approve the override (#634: SyncHub creates the Bid Board
-- project — that path already notifies) or RE-CONFIRM the denial. The re-confirm is the terminal "we looked
-- again and upheld the no-go," and until now it sent nothing. This trigger fires on that transition,
-- REGARDLESS of which path wrote it (today: reconfirmRfpDecline in rfp-override-service.ts), so it stays
-- decoupled from the route/service code — exactly like 0148.
--
-- DESIGN INVARIANTS (mirrors migration 0148's structure/guards):
--   * RE-CONFIRM ONLY. Attached AFTER UPDATE OF rfp_override_decision, and the function enqueues only when
--     NEW.rfp_override_decision='denial_reconfirmed' AND OLD is DISTINCT FROM it. The approve path sets a
--     different value ('override_approved') and is excluded; a bid-board-created callback / page read never
--     targets rfp_override_decision, so neither fires this. All gating lives IN THE FUNCTION (no WHEN clause),
--     so the runtime test exercises the real gating and inverting any guard breaks it (load-bearing).
--   * ONCE PER RFP CYCLE. The cycle's identity is rfp_approval_request_id. The receipts ledger
--     (public.rfp_reconfirm_email_receipts, keyed (tenant_schema, deal_id, rfp_approval_request_id)) is the
--     worker's exactly-once guard. A repeated re-confirm makes no transition (OLD already
--     'denial_reconfirmed') -> no enqueue. The reconfirm is terminal, so there is no in-cycle re-fire.
--   * BEST-EFFORT. A notification-path failure (job_queue outage, etc.) must NEVER roll back or block the
--     re-confirm write that fired this trigger. The enqueue is wrapped so any error logs a WARNING and the
--     re-confirm commits intact. Mirrors 0148.
--   * NO AUDIT MARKER. The cycle key is carried by rfp_approval_request_id and the re-confirm is already
--     audited by rfp-override-service.ts. So this needs no audit_log marker — just the trigger + ledger.
--
-- This is a two-service deploy: the SERVER applies this migration (the trigger), the WORKER ships the
-- rfp_reconfirm_denial_email handler. Both must redeploy.

CREATE OR REPLACE FUNCTION public.enqueue_rfp_reconfirm_denial_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_number text;
  v_request_id integer;
  v_declined_reason text;
BEGIN
  -- Re-confirm-only: act solely on the transition INTO 'denial_reconfirmed'. The approve path
  -- ('override_approved') and any non-decision write are excluded. Defensive in-function gating (no WHEN
  -- clause), so the function self-guards regardless of how the trigger is attached.
  IF NEW.rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed' THEN
    RETURN NEW;
  END IF;
  IF OLD.rfp_override_decision IS NOT DISTINCT FROM 'denial_reconfirmed' THEN
    -- Already re-confirmed (a repeated action / re-fire on the same row) -> not a fresh transition.
    RETURN NEW;
  END IF;

  -- The RFP cycle's identity. The receipts ledger and idempotencyKey are keyed on it, so without it there
  -- is no once-only guard to rely on. A genuine re-confirm carries it (the deal went through the RFP flow),
  -- so NULL here is a non-RFP-flow write -> skip.
  v_request_id := NEW.rfp_approval_request_id;
  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_deal_number := NULLIF(BTRIM(NEW.deal_number), '');
  v_declined_reason := NULLIF(BTRIM(NEW.rfp_declined_reason), '');

  -- Bulk-script / migration escape hatch (mirrors app.skip_rfp_rejected_email on the 0148 trigger).
  IF lower(coalesce(current_setting('app.skip_rfp_reconfirm_email', true), '')) IN ('1', 'true', 'yes', 'on') THEN
    RETURN NEW;
  END IF;

  -- Best-effort from here: the notification is strictly secondary and must NEVER abort the re-confirm write
  -- that fired this trigger. Mirrors 0148 — log a WARNING on failure and let the re-confirm commit.
  BEGIN
    INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
    VALUES (
      'rfp_reconfirm_denial_email',
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
    RAISE WARNING 'enqueue_rfp_reconfirm_denial_email: notification enqueue failed for deal % (re-confirm preserved): %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Sent-email receipt ledger (worker retry idempotency). Keyed (tenant_schema, deal_id,
-- rfp_approval_request_id) — the RFP cycle's identity — so each cycle's re-confirm sends exactly once.
-- Independent table, like 0148's receipts (a deal can get both a decline email and, later, a re-confirm
-- email for the same cycle — they are distinct events with distinct ledgers).
CREATE TABLE IF NOT EXISTS public.rfp_reconfirm_email_receipts (
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

CREATE INDEX IF NOT EXISTS rfp_reconfirm_email_receipts_deal_idx
  ON public.rfp_reconfirm_email_receipts (tenant_schema, deal_id);

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
        DROP TRIGGER IF EXISTS deals_rfp_reconfirm_denial_email_trg ON %I.deals;

        CREATE TRIGGER deals_rfp_reconfirm_denial_email_trg
          AFTER UPDATE OF rfp_override_decision ON %I.deals
          FOR EACH ROW
          EXECUTE FUNCTION public.enqueue_rfp_reconfirm_denial_email();
      $sql$,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS deals_rfp_reconfirm_denial_email_trg ON office_dallas.deals;

CREATE TRIGGER deals_rfp_reconfirm_denial_email_trg
  AFTER UPDATE OF rfp_override_decision ON office_dallas.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_rfp_reconfirm_denial_email();
-- TENANT_SCHEMA_END
