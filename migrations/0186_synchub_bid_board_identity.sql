-- Migration 0186: durable SyncHub Bid Board identity on tenant deals.
--
-- A project name is not an identity: multiple projects at the same property can legitimately
-- share it. Store the required SyncHub `bid_board_id` and enforce one such identity per tenant
-- so webhook replays are idempotent without ever matching by name.

DO $tenant$
DECLARE
  schema_name text;
  has_updated_at_trigger boolean;
BEGIN
  FOR schema_name IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
     ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS synchub_bid_board_id text',
      schema_name
    );

    -- SyncHub audit entries have persisted the durable bidBoardId in full_row since the webhook
    -- began writing rich audit metadata. Recover legacy rows from that source before enforcing
    -- uniqueness. Prefer a single identity recorded by the explicit insert audit; for older rows
    -- that were first linked by updates, backfill only when every SyncHub audit agrees. If historical
    -- replay bugs associated one identity with more than one deal, only the earliest association is
    -- claimed; ambiguous rows remain NULL rather than making the migration fail or guessing by name.
    IF to_regclass(format('%I.audit_log', schema_name)) IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM pg_trigger trigger_row
          JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
          JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         WHERE namespace_row.nspname = schema_name
           AND table_row.relname = 'deals'
           AND trigger_row.tgname = 'set_deals_updated_at'
           AND NOT trigger_row.tgisinternal
      ) INTO has_updated_at_trigger;

      -- This is identity metadata recovery, not a user-visible deal edit. Preserve the existing
      -- business-freshness timestamp used by at-risk reporting while the backfill runs.
      IF has_updated_at_trigger THEN
        EXECUTE format('ALTER TABLE %I.deals DISABLE TRIGGER set_deals_updated_at', schema_name);
      END IF;

      EXECUTE format(
        $backfill$
          WITH candidate_events AS (
            SELECT
              a.record_id AS deal_id,
              NULLIF(BTRIM(a.full_row ->> 'bidBoardId'), '') AS bid_board_id,
              a.created_at AS audit_created_at,
              a.id AS audit_id,
              a.action::text = 'insert' AS is_insert
            FROM %1$I.audit_log a
            JOIN %1$I.deals d ON d.id = a.record_id
            WHERE d.synchub_bid_board_id IS NULL
              AND a.table_name = 'deals'
              AND a.actor_system_process = 'Procore SyncHub Webhook'
              AND NULLIF(BTRIM(a.full_row ->> 'bidBoardId'), '') IS NOT NULL
          ),
          deal_identity_stats AS (
            SELECT
              deal_id,
              COUNT(DISTINCT bid_board_id) FILTER (WHERE is_insert) AS insert_identity_count,
              COUNT(DISTINCT bid_board_id) AS total_identity_count,
              MIN(bid_board_id) FILTER (WHERE is_insert) AS insert_identity,
              MIN(bid_board_id) AS only_identity
            FROM candidate_events
            GROUP BY deal_id
          ),
          unambiguous_deal_identities AS (
            SELECT
              deal_id,
              CASE
                WHEN insert_identity_count = 1 THEN insert_identity
                ELSE only_identity
              END AS bid_board_id
            FROM deal_identity_stats
            WHERE insert_identity_count = 1
               OR (insert_identity_count = 0 AND total_identity_count = 1)
          ),
          one_identity_per_deal AS (
            SELECT DISTINCT ON (identity.deal_id)
              identity.deal_id,
              identity.bid_board_id,
              event.audit_created_at,
              event.audit_id
            FROM unambiguous_deal_identities identity
            JOIN candidate_events event
              ON event.deal_id = identity.deal_id
             AND event.bid_board_id = identity.bid_board_id
            ORDER BY identity.deal_id, event.audit_created_at ASC, event.audit_id ASC
          ),
          ranked_identities AS (
            SELECT
              deal_id,
              bid_board_id,
              ROW_NUMBER() OVER (
                PARTITION BY bid_board_id
                ORDER BY audit_created_at ASC, audit_id ASC, deal_id ASC
              ) AS identity_rank
            FROM one_identity_per_deal
          )
          UPDATE %1$I.deals d
             SET synchub_bid_board_id = r.bid_board_id
            FROM ranked_identities r
           WHERE d.id = r.deal_id
             AND d.synchub_bid_board_id IS NULL
             AND r.identity_rank = 1
             AND NOT EXISTS (
               SELECT 1
                 FROM %1$I.deals established
                WHERE established.synchub_bid_board_id = r.bid_board_id
             )
        $backfill$,
        schema_name
      );

      IF has_updated_at_trigger THEN
        EXECUTE format('ALTER TABLE %I.deals ENABLE TRIGGER set_deals_updated_at', schema_name);
      END IF;
    END IF;

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deals_synchub_bid_board_id_uidx ON %I.deals (synchub_bid_board_id) WHERE synchub_bid_board_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants are cloned from office_dallas by the office provisioner.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS synchub_bid_board_id text;
CREATE UNIQUE INDEX IF NOT EXISTS deals_synchub_bid_board_id_uidx
  ON office_dallas.deals (synchub_bid_board_id)
  WHERE synchub_bid_board_id IS NOT NULL;
-- TENANT_SCHEMA_END
