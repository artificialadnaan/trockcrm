-- Heartbeat alert state for the Bid Board → CRM sync silence detector.
--
-- The CRM ingest runs in ONE transaction and ROLLS BACK on any error, so a failed run leaves NO
-- bid_board_sync_runs row — the only signal of an outage is the ABSENCE of a recent COMMITTED success
-- (status IN 'success','completed_with_unmatched'). The bid-board-sync-heartbeat cron detects that
-- absence per office and emails. This table makes the alert idempotent across cron invocations:
-- it throttles re-alerts (alert on entering 'stalled', then at most once per re-alert window) and
-- records the transition back to 'ok' so exactly one recovery email is sent.
--
-- Public (not per-office) and keyed by office_slug so a single cron process covers every office.
CREATE TABLE IF NOT EXISTS public.bid_board_sync_alert_state (
  office_slug      text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'stalled')),
  last_alerted_at  timestamptz,                  -- when we last emailed a stalled alert (throttle anchor)
  last_success_at  timestamptz,                  -- last committed-success seen at the time of the check
  updated_at       timestamptz NOT NULL DEFAULT now()
);
