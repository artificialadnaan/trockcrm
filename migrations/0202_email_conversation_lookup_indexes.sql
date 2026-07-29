-- Migration 0202: index the two conversation-id lookups the email thread reassign/unassign feature
-- hammers. Neither predicate had an index that can SEEK on it — the emails side had no index at all
-- (Seq Scan every time), the bindings side only one whose leading column these queries never supply.
--
-- MEASURED on the thread routes (server/src/modules/email/{routes,service}.ts), counting only
-- statements whose predicate is `graph_conversation_id = $1`:
--
--   GET /api/email/thread/:conversationId  -> 4 SELECTs on emails.graph_conversation_id
--     1. conversationHasAnyMessage -> findAnyEmailInConversation           (LIMIT 1)
--     2. gateEmailThreadAccess -> getEmailThreadForMutation, main select   (ORDER BY sent_at, id)
--     3. getEmailThreadForMutation's connected-mailbox lookup              (ORDER BY sent_at, id LIMIT 1)
--     4. readThreadForGatedCaller -> getEmailThread, main select           (ORDER BY sent_at, id)
--
--   POST /api/email/thread/:conversationId/detach  -> 6 SELECTs + 1 UPDATE = 7 passes
--     1-2. gateEmailThreadAccess -> getEmailThreadForMutation (main + connected-mailbox)
--     3.   detachConversationAcrossMailboxes, pre-clear stat-target read  (ORDER BY sent_at, id)
--     4.   the same function's blanket `UPDATE emails ... WHERE graph_conversation_id = $1`
--     5-7. readThreadForGatedCaller (no threadContext after a mutation) -> getEmailThread's main
--          select PLUS a fresh getEmailThreadForMutation (its two selects again)
--
-- This matters on THIS deployment specifically: the API has a known pool-saturation failure mode whose
-- only symptom is "Couldn't load deals" and whose only relief is an API restart. The reassign/unassign
-- UI is what starts driving real traffic through these paths, and it roughly doubles the per-open cost
-- of a thread, so leaving seven Seq Scans per detach on the table is how that gets tripped.
--
-- TWO GAPS, one per table:
--
--   1. emails.graph_conversation_id had NO index at all. The column is declared once, in
--      migrations/0001_initial.sql, and nothing has indexed it since.
--
--      -> emails_graph_conversation_sent_at_idx (graph_conversation_id, sent_at, id)
--         PARTIAL on `graph_conversation_id IS NOT NULL`: every query above is an equality, which never
--         matches NULL, and CRM-composed rows that never got a Graph conversation id are dead weight in
--         the index otherwise. Same shape as emails_internet_message_id_idx (0163).
--         `sent_at` is there because 9 of those 11 passes carry `ORDER BY sent_at ASC, id ASC`; `id` is
--         there because sent_at TIES ARE THE NORMAL CASE here, not an edge case — the sync stores one
--         row per mailbox and every copy of a message carries the SENDER's timestamp, so a conversation
--         with N participants has N rows sharing each sent_at. Without the id column those ties need a
--         sort on top of the index scan, which also costs the connected-mailbox lookup its LIMIT 1
--         pushdown. With it the index answers the ordering outright. Measured on a scratch PGlite DB at
--         8,000 emails / 800 conversations:
--           thread read (ORDER BY sent_at, id):
--             before -> Seq Scan + Sort                                        cost=0.00..271.19
--             after  -> Bitmap Index Scan on emails_graph_conversation_sent_at_idx  cost=4.36..37.42
--           oldest-message lookup (ORDER BY sent_at, id LIMIT 1):
--             before -> Seq Scan + Sort + Limit                                cost=0.00..271.05
--             after  -> Index Only Scan, no Sort node at all                   cost=0.28..4.69
--
--   2. email_thread_bindings HAS a unique index for this predicate —
--      uq_email_thread_bindings_active_conversation (0028) — but it is LED BY mailbox_account_id:
--        (mailbox_account_id, provider, provider_conversation_id)
--        WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL
--      Every lookup this feature adds is deliberately mailbox-LESS — resolveActiveBindingDealIdForConversation,
--      resolveMailboxAccountIdsWithActiveBindingForConversation, and the detach's blanket binding UPDATE
--      all filter on (provider, provider_conversation_id, detached_at IS NULL) with no mailbox, because
--      "what deal is this thread on" and "which mailboxes hold it" are questions about the CONVERSATION.
--      (Detach takes 2 such passes, assign/reassign 2.)
--      With the leading column unbound the planner still PICKS that index, which is what makes this one
--      easy to miss — but only as a FULL index scan with the conditions applied as a filter, no seek
--      bound. Measured on a scratch PGlite DB at 4,000 bindings / 800 conversations / 5 mailboxes each:
--        before -> Index Scan using uq_email_thread_bindings_active_conversation  cost=0.28..112.30
--        after  -> Index Scan using email_thread_bindings_active_conversation_idx cost=0.28..10.07
--
--      -> email_thread_bindings_active_conversation_idx (provider, provider_conversation_id)
--         WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL
--         NOT a duplicate of the unique index: different leading column, and neither column list is a
--         usable prefix of the other. NOT unique, and must not be — several mailboxes legitimately hold
--         an active binding for one conversation, which is the whole reason
--         resolveMailboxAccountIdsWithActiveBindingForConversation returns a list. Predicate copied from
--         the unique index so the two cover the same row set (active, real-conversation bindings only,
--         excluding the subject+fingerprint provisional ones).
--
-- Built NON-concurrently, plain CREATE INDEX, following 0166's precedent on this same table: emails is
-- at the ~5K-8K row scale here so the build is sub-second, and CREATE INDEX CONCURRENTLY cannot run
-- inside the DO/tenant loop the migration runner executes this file in anyway.
--
-- Schema source-of-truth: shared/src/schema/tenant/{emails,email-thread-bindings}.ts declare both
-- indexes with a marker comment pointing back here (the pattern emails_contact_sent_at_idx / 0166 set).
--
-- Existing tenants get the DO block; the TENANT_SCHEMA block is what the office provisioner
-- (server/src/modules/office/service.ts) replays for FUTURE offices. IF NOT EXISTS throughout, so the
-- file is idempotent and replayable.
--
-- NOTE on the guard in the TENANT_SCHEMA block: migration 0028 creates email_thread_bindings ONLY in a
-- DO loop over already-existing office_% schemas and ships NO TENANT_SCHEMA block of its own, so a
-- freshly provisioned office has `emails` (0001 provisions it) but NOT `email_thread_bindings`. An
-- unguarded CREATE INDEX on that table would abort provisioning for every new office. That 0028 gap is
-- pre-existing and out of scope here; the to_regclass check just makes sure this migration does not
-- turn it into a hard failure.

-- Existing tenants.
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
    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS emails_graph_conversation_sent_at_idx ON %I.emails (graph_conversation_id, sent_at, id) WHERE graph_conversation_id IS NOT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.email_thread_bindings', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS email_thread_bindings_active_conversation_idx ON %I.email_thread_bindings (provider, provider_conversation_id) WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS emails_graph_conversation_sent_at_idx
  ON office_dallas.emails (graph_conversation_id, sent_at, id)
  WHERE graph_conversation_id IS NOT NULL;

DO $etb_idx$
BEGIN
  IF to_regclass('office_dallas.email_thread_bindings') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS email_thread_bindings_active_conversation_idx
      ON office_dallas.email_thread_bindings (provider, provider_conversation_id)
      WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL;
  END IF;
END
$etb_idx$;
-- TENANT_SCHEMA_END
