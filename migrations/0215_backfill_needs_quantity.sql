-- Migration 0215: park already-priced rows that never had a usable quantity.
--
-- WHY A BACKFILL IS REQUIRED AND NOT A TIDY-UP. Before the change this ships with, an extraction with
-- no quantity was priced as ONE UNIT: `Number(extraction.quantity ?? 1)` at three sites in the
-- estimate-generation worker. Those rows were priced, marked `processed`, and are sitting in deals now
-- carrying a number nothing supports.
--
-- Deploying the fix alone strands them, and the trap closes from three sides at once:
--   * the worker's candidate filter admits ordinary rows only at `status = 'pending'`, so a `processed`
--     row never reaches the new unpriceable guard and is never re-examined;
--   * the new promote predicate REFUSES their recommendation, so the number they do carry can no longer
--     reach an estimate — correctly, but silently;
--   * and `status = 'processed'` keeps them out of the `needsQuantity` bucket, which is the one place
--     the workbench surfaces "a human has to supply this".
-- The row is therefore invisible in every direction: unpriceable, unpromotable, and unlisted. No edit
-- is needed to reach that state — deployment alone is enough, which is what makes this a migration
-- rather than something the application can fix on its next run.
--
-- WHAT COUNTS AS UNPRICEABLE is the same definition the application uses (see `isPriceable` in
-- extraction-review-service.ts and the worker's guard): absent, nonpositive, or NaN. NaN is named
-- explicitly because Postgres orders numeric NaN ABOVE all finite values — `quantity > 0` is TRUE for
-- it, so a positive test alone would leave NaN rows behind, which is exactly the mistake this codebase
-- made twice while getting here.
--
-- ONLY `processed`. `approved`, `rejected` and `overridden` are human decisions and are not this
-- migration's to overwrite; their recommendations are already held out of the promote by the same
-- predicate. `pending` rows need no help — the worker will pick them up and flag them itself.
--
-- IDEMPOTENT: a row already at `needs_quantity` is not matched, so a replay changes nothing.

DO $tenant$
DECLARE
  schema_name text;
  moved bigint;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- A half-provisioned schema must not take the migration down for every other office; the same
    -- guard every tenant migration in this directory carries.
    IF to_regclass(format('%I.estimate_extractions', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $bf$UPDATE %I.estimate_extractions
             SET status = 'needs_quantity',
                 updated_at = now()
           WHERE status = 'processed'
             AND (
               quantity IS NULL
               OR quantity <= 0
               OR quantity = 'NaN'::numeric
             )$bf$,
      schema_name
    );
    GET DIAGNOSTICS moved = ROW_COUNT;

    -- Said out loud per office. A silent backfill of pricing state is exactly the kind of change
    -- somebody needs to be able to find in a deploy log six weeks later.
    RAISE NOTICE '0215: % extraction(s) moved to needs_quantity in %', moved, schema_name;
  END LOOP;
END $tenant$;
