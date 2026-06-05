-- 0155_rfp_override_approved_email.sql
--
-- Email the requesting rep + leadership when an OVERRIDE-approve is CONFIRMED successful — i.e. the SyncHub
-- `bid-board-created` callback has flipped the deal to rfp_approval_status='approved' (Bid Board project
-- created + deal advanced), NOT on the initial approve click (which only parks the deal 'approving').
--
-- WHY: the override-review gate lets reviewers approve the override or re-confirm the denial. #651 (migration
-- 0154) notifies on a RE-CONFIRM; this is the positive counterpart — the "override approved, project created"
-- notice. The approve CLICK (requestOverrideApproval) sets rfp_override_decision='override_approved' +
-- rfp_override_state='approving' and leaves rfp_approval_status='declined' (unconfirmed — it may still fail),
-- so emailing then would be premature. Only the success `created` callback's linkage UPDATE
-- (server/src/modules/internal-rfp/routes.ts) flips rfp_approval_status -> 'approved' (atomically with
-- procore_bid_id), which is the confirmed-success signal we fire on.
--
-- DESIGN INVARIANTS (mirrors migrations 0148/0154):
--   * CONFIRMED OVERRIDE-SUCCESS ONLY. Attached AFTER UPDATE OF rfp_approval_status; the function enqueues only
--     when NEW.rfp_approval_status='approved' AND OLD is DISTINCT FROM it AND NEW.rfp_override_decision=
--     'override_approved'. The approve click and the failure callback never touch rfp_approval_status (so the
--     UPDATE OF filter excludes them); an ORIGINAL (non-override) approval reaches 'approved' with a NULL
--     decision and is excluded by the decision guard. All gating is IN THE FUNCTION (no WHEN clause), so the
--     runtime test exercises the real gating and inverting any guard breaks it (load-bearing).
--   * ONCE PER RFP CYCLE. The cycle's identity is rfp_approval_request_id. The receipts ledger
--     (public.rfp_override_approved_email_receipts, keyed (tenant_schema, deal_id, rfp_approval_request_id)) is
--     the worker's exactly-once guard. A duplicate/replayed `created` callback makes no transition (OLD already
--     'approved') -> no enqueue.
--   * BEST-EFFORT. A notification-path failure (job_queue outage, etc.) must NEVER roll back or block the
--     linkage write that fired this trigger. The enqueue is wrapped so any error logs a WARNING and the linkage
--     commits intact. Mirrors 0148/0154.
--   * NO AUDIT MARKER. The cycle key is carried by rfp_approval_request_id and the linkage is already audited by
--     the callback handler. So this needs no audit_log marker — just the trigger + ledger.
--
-- This is a two-service deploy: the SERVER applies this migration (the trigger), the WORKER ships the
-- rfp_override_approved_email handler. Both must redeploy.

CREATE OR REPLACE FUNCTION public.enqueue_rfp_override_approved_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_number text;
  v_request_id integer;
BEGIN
  -- Confirmed-success-only: act solely on the transition INTO 'approved'. The approve click and failure
  -- callback never write rfp_approval_status; a re-delivered `created` makes no fresh transition. Defensive
  -- in-function gating (no WHEN clause), so the function self-guards regardless of how the trigger is attached.
  IF NEW.rfp_approval_status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  IF OLD.rfp_approval_status IS NOT DISTINCT FROM 'approved' THEN
    -- Already approved (a duplicate/replayed created callback) -> not a fresh success.
    RETURN NEW;
  END IF;
  -- OVERRIDE flow only: the approve click stamped rfp_override_decision='override_approved' and the `created`
  -- callback leaves it set. An ORIGINAL (non-override) approval reaches 'approved' with a NULL decision -> skip
  -- (that happy path has no override and is out of scope for this notification).
  IF NEW.rfp_override_decision IS DISTINCT FROM 'override_approved' THEN
    RETURN NEW;
  END IF;

  -- The RFP cycle's identity. The receipts ledger and idempotencyKey are keyed on it, so without it there is no
  -- once-only guard to rely on. A genuine override-approval carries it, so NULL here is a non-RFP-flow write -> skip.
  v_request_id := NEW.rfp_approval_request_id;
  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_deal_number := NULLIF(BTRIM(NEW.deal_number), '');

  -- Bulk-script / migration escape hatch (mirrors app.skip_rfp_rejected_email / app.skip_rfp_reconfirm_email).
  IF lower(coalesce(current_setting('app.skip_rfp_override_approved_email', true), '')) IN ('1', 'true', 'yes', 'on') THEN
    RETURN NEW;
  END IF;

  -- Best-effort from here: the notification is strictly secondary and must NEVER abort the linkage write that
  -- fired this trigger. Mirrors 0148/0154 — log a WARNING on failure and let the linkage commit.
  BEGIN
    INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
    VALUES (
      'rfp_override_approved_email',
      jsonb_build_object(
        'tenantSchema', TG_TABLE_SCHEMA,
        'dealId', NEW.id,
        'dealNumber', v_deal_number,
        'dealName', NEW.name,
        'rfpApprovalRequestId', v_request_id,
        'requestedByUserId', NEW.rfp_approval_requested_by
      ),
      NULL,
      'pending',
      NOW()
    );
  EXCEPTION WHEN others THEN
    RAISE WARNING 'enqueue_rfp_override_approved_email: notification enqueue failed for deal % (approval preserved): %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Sent-email receipt ledger (worker retry idempotency). Keyed (tenant_schema, deal_id,
-- rfp_approval_request_id) — the RFP cycle's identity — so each cycle's override-approval sends exactly once.
-- Independent table, like 0148's/0154's receipts (the decline, re-confirm, and approve-success emails are
-- distinct events with distinct ledgers).
CREATE TABLE IF NOT EXISTS public.rfp_override_approved_email_receipts (
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

CREATE INDEX IF NOT EXISTS rfp_override_approved_email_receipts_deal_idx
  ON public.rfp_override_approved_email_receipts (tenant_schema, deal_id);

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
        DROP TRIGGER IF EXISTS deals_rfp_override_approved_email_trg ON %I.deals;

        CREATE TRIGGER deals_rfp_override_approved_email_trg
          AFTER UPDATE OF rfp_approval_status ON %I.deals
          FOR EACH ROW
          EXECUTE FUNCTION public.enqueue_rfp_override_approved_email();
      $sql$,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS deals_rfp_override_approved_email_trg ON office_dallas.deals;

CREATE TRIGGER deals_rfp_override_approved_email_trg
  AFTER UPDATE OF rfp_approval_status ON office_dallas.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_rfp_override_approved_email();
-- TENANT_SCHEMA_END
