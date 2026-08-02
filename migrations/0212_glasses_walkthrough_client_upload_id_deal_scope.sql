-- Migration 0212: re-key glasses-walkthrough `files` rows written before `client_upload_id` was deal-scoped.
--
-- ROOT CAUSE: the mobile app derives every walk-artifact idempotency key from (walkId, kind[, photoIndex])
-- and nothing else (walkArtifactIdempotencyKey, mobile/src/walkthrough/upload-core.ts), while
-- files.client_upload_id is unique across the WHOLE tenant (0170). Filing one physical walk against a
-- second deal — a mis-tagged walk corrected, or a recovered orphan walk whose deal a human supplies at
-- recovery time — therefore re-sent byte-identical keys and was refused permanently. The ingress now
-- stores a deal-scoped digest instead (deriveGlassesWalkthroughClientUploadId,
-- server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts).
--
-- WHY THE ALREADY-WRITTEN ROWS CANNOT SIMPLY BE LEFT: files.r2_key carries its own UNIQUE constraint, and
-- the R2 key derivation is unchanged. A retried completion of a walk filed under the OLD scheme inserts a
-- row whose client_upload_id no longer collides — so the completion's `ON CONFLICT (client_upload_id) DO
-- NOTHING` arbiter never fires — and whose r2_key collides exactly as before. That raises SQLSTATE 23505
-- inside the request transaction: a 500 on the precise retry path per-artifact idempotency exists to make
-- safe, for a walk that is already correctly filed. Rows in this shape exist in production (the feature's
-- end-to-end hardware validation), so this is a repair, not housekeeping.
--
-- THE DERIVATION, mirrored from the TypeScript exactly: 'gw_' || left(sha256(deal_id || NUL || raw key), 61)
-- in hex — 3 + 61 = the varchar(64) column. Node hashes the UTF-8 bytes of `${dealId}\u0000${key}`, hence
-- convert_to(..., 'UTF8') on both sides of a literal 0x00 byte rather than a text concatenation (Postgres
-- rejects NUL inside text outright, which is also why NUL is the separator: it is the one byte neither
-- component can contain, so the pair cannot be re-cut into a different pair that digests the same).
-- server/tests/migrations/0212-glasses-walkthrough-client-upload-id-deal-scope.runtime.test.ts executes
-- this file against a real Postgres and asserts the two implementations agree byte for byte; they are two
-- expressions of one derivation, and a silent divergence would leave every repaired row a different kind
-- of orphan while looking like a success.
--
-- SCOPE: subcategory = 'glasses-walkthrough' only. `files` is the busiest table in a tenant and
-- client_upload_id is shared with the field-photo queue and scorecard edit evidence, whose keys are
-- client-minted UUIDs the mobile app still matches its own queue entries against — rewriting one of those
-- would break a dedupe unrelated to this change. Rows that already carry a 'gw_' id are skipped, which is
-- what makes the file idempotent/replayable; rows with a NULL client_upload_id or a NULL deal_id are
-- skipped too, because sha256 of a NULL is NULL and assigning that would drop the row out of the partial
-- unique index altogether — losing idempotency rather than repairing it.
--
-- Per-tenant (office_*) only. There is no TENANT_SCHEMA block: this is a data repair, and a newly
-- provisioned office has no rows to repair.

DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.files', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        UPDATE %I.files
        SET client_upload_id = 'gw_' || substr(
          encode(
            sha256(
              convert_to(deal_id::text, 'UTF8')
                || '\x00'::bytea
                || convert_to(client_upload_id, 'UTF8')
            ),
            'hex'
          ),
          1,
          61
        )
        WHERE subcategory = 'glasses-walkthrough'
          AND client_upload_id IS NOT NULL
          AND client_upload_id NOT LIKE 'gw\_%%' ESCAPE '\'
          AND deal_id IS NOT NULL
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$mig$;
