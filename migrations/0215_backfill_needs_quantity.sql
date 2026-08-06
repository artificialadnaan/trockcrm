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
  flagged bigint;
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

    -- PARKING THE SOURCE DOES NOT UNDO THE PRICE. Some of those extractions were already PROMOTED, and
    -- their estimate_line_items row is sitting in a client-facing estimate carrying the fabricated
    -- quantity of 1, with its amount still in the totals. Moving the extraction to `needs_quantity`
    -- makes the source correctable; it does nothing to the line already quoted. Supplying the real
    -- quantity and rerunning then produces a CORRECTED recommendation alongside the stale line, so
    -- without this the historical mispricing not only survives the deploy, it can be double-counted.
    --
    -- SURFACED, NOT DELETED. This migration will not silently alter a number a client has been shown:
    -- removing or rewriting an already-quoted line is an estimator's decision, and one that needs the
    -- deal in front of them. What the backfill owes them is to make the set findable and to say so.
    -- `estimate_review_events` is the durable place for that — queryable, per-deal, and already the
    -- record every other promote/override decision lands in.
    --
    -- IDEMPOTENT via NOT EXISTS on the same (subject, event_type) pair, matching the UPDATE above: a
    -- replay records nothing twice. `user_id` is NULL because no person did this.
    IF to_regclass(format('%I.estimate_review_events', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        $rem$INSERT INTO %I.estimate_review_events
               (deal_id, subject_type, subject_id, event_type, before_json, after_json, reason, user_id)
             SELECT r.deal_id,
                    'estimate_line_item',
                    r.promoted_estimate_line_item_id,
                    'remediation_required',
                    jsonb_build_object(
                      'quantity', li.quantity,
                      'extractionId', e.id,
                      'extractionQuantity', e.quantity,
                      'recommendationId', r.id
                    ),
                    '{}'::jsonb,
                    'Migration 0215: promoted from an extraction that had no usable quantity, so this '
                      || 'line was priced as ONE UNIT. The source extraction is now needs_quantity. '
                      || 'Re-price or void this line; it is still counted in the estimate total.',
                    NULL
               FROM %I.estimate_extractions e
               JOIN %I.estimate_extraction_matches m ON m.extraction_id = e.id
               JOIN %I.estimate_pricing_recommendations r ON r.extraction_match_id = m.id
               JOIN %I.estimate_line_items li ON li.id = r.promoted_estimate_line_item_id
              WHERE e.status = 'needs_quantity'
                AND r.promoted_estimate_line_item_id IS NOT NULL
                AND (
                  e.quantity IS NULL
                  OR e.quantity <= 0
                  OR e.quantity = 'NaN'::numeric
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM %I.estimate_review_events x
                   WHERE x.subject_id = r.promoted_estimate_line_item_id
                     AND x.event_type = 'remediation_required'
                )$rem$,
        schema_name, schema_name, schema_name, schema_name, schema_name, schema_name
      );
      GET DIAGNOSTICS flagged = ROW_COUNT;

      RAISE NOTICE '0215: % already-promoted line item(s) flagged for remediation in %', flagged, schema_name;
    END IF;

    -- Said out loud per office. A silent backfill of pricing state is exactly the kind of change
    -- somebody needs to be able to find in a deploy log six weeks later.
    RAISE NOTICE '0215: % extraction(s) moved to needs_quantity in %', moved, schema_name;
  END LOOP;
END $tenant$;
