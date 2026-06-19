-- Migration 0166: contacts last_touch_at perf fix — partial touch indexes on emails + tasks.
--
-- ROOT CAUSE (prod-verified, office_dallas via DATABASE_PUBLIC_URL, warm cache): sorting the contacts
-- list by last_touch_at (a #770 sortable header + the persisted "Last touch" quick-sort) orders by
-- buildContactLastTouchAtSql() — GREATEST(last_contacted_at, MAX activity/email/task). That ORDER BY
-- expression defeats LIMIT pushdown, so the correlated MAX() subqueries run for ALL ~2,127 active
-- contacts. activities is already indexed (activities_contact_idx), but emails.contact_id and
-- tasks.contact_id were UNINDEXED → SubPlan 6 (emails) + 7 (tasks) full Seq Scan ×2,127.
--   ORDER BY updated_at DESC LIMIT 50  ->   91.9 ms /  90,018 buffers
--   ORDER BY last_touch_at ... LIMIT 50 -> 3,178 ms / 3,789,171 buffers (Seq Scan emails+tasks)
--
-- FIX: partial indexes mirroring activities_contact_idx so SubPlan 6/7 become Index Only Scan Backward
-- (buffers ~3.79M -> ~10K, sub-second). Schema source-of-truth: shared/src/schema/tenant/{emails,tasks}.ts
-- declare emails_contact_sent_at_idx / tasks_contact_updated_at_idx.
--
-- Per-office DO-loop over tenant schemas (these tables live per tenant, NOT in public). A concurrent
-- index build is illegal inside a DO/txn block, so plain CREATE INDEX IF NOT EXISTS (sub-second at the
-- current 5K-8K row scale). PARTIAL (WHERE contact_id IS NOT NULL) to stay small and match the predicate.

DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS emails_contact_sent_at_idx ON %I.emails (contact_id, sent_at DESC) WHERE contact_id IS NOT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.tasks', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS tasks_contact_updated_at_idx ON %I.tasks (contact_id, updated_at DESC) WHERE contact_id IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $mig$;
