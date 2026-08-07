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
  surfaced bigint;
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
    -- EVERY RELATION THE STATEMENT TOUCHES, not just the one it writes to. The query joins matches,
    -- recommendations and line items, and a missing relation raises INSIDE this DO block — which
    -- aborts the whole migration, so a single half-provisioned office would stop every office after it
    -- from being parked at all. The partial schema turns into a silent no-op deploy for everybody.
    -- Guarding only the INSERT target made that failure depend on which table a schema happened to be
    -- missing, which is not a property anyone should have to reason about at deploy time.
    IF to_regclass(format('%I.estimate_review_events', schema_name)) IS NOT NULL
       AND to_regclass(format('%I.estimate_extraction_matches', schema_name)) IS NOT NULL
       AND to_regclass(format('%I.estimate_pricing_recommendations', schema_name)) IS NOT NULL
       AND to_regclass(format('%I.estimate_line_items', schema_name)) IS NOT NULL THEN
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
                    -- THE REASON MUST BE TRUE OF THE ROW IT IS ATTACHED TO. This used to say the line
                    -- "was priced as ONE UNIT", which is only the NULLISH case: resolvePromotionLineValues
                    -- substitutes 1 when the recommendation's quantity is null, but a stored 0, negative
                    -- or NaN was promoted AS ITSELF — and this migration deliberately selects those too.
                    -- A remediation task carrying a number the line never had is false diagnostic
                    -- information on exactly the rows somebody is being asked to trust, so the quantity
                    -- is quoted from the line instead of asserted.
                    'Migration 0215: promoted from an extraction that had no usable quantity, so this '
                      || 'line was priced at a quantity of ' || li.quantity::text || ', which was not '
                      || 'measured. The source extraction is now needs_quantity. Re-price or void this '
                      || 'line; it is still counted in the estimate total.',
                    NULL
               FROM %I.estimate_extractions e
               JOIN %I.estimate_extraction_matches m ON m.extraction_id = e.id
               JOIN %I.estimate_pricing_recommendations r ON r.extraction_match_id = m.id
               JOIN %I.estimate_line_items li ON li.id = r.promoted_estimate_line_item_id
              WHERE e.status = 'needs_quantity'
                AND r.promoted_estimate_line_item_id IS NOT NULL
                -- ONLY LINES WHOSE NUMBER ACTUALLY CAME FROM THIS EXTRACTION. A manual recommendation
                -- promotes its own manualQuantity, and an override with a quantity of its own promotes
                -- that — for both, the anchor extraction is only an artifact link, and the quoted line
                -- may be perfectly correct. Flagging those would tell an estimator a valid line was
                -- fabricated as one unit and ask them to void it: a false remediation task is worse
                -- than none, because it teaches people to ignore the queue.
                --
                -- DELIBERATELY NOT THE PROMOTE PREDICATE'S OVERRIDE BRANCH, which additionally requires
                -- the override quantity to be positive and finite. The two ask different questions:
                -- promotion asks "is this row safe to price NOW", this asks "did this line's number
                -- come from the invalid extraction". resolvePromotionLineValues does
                -- `quantity = row.overrideQuantity ?? quantity`, and nullish-coalescing falls back on
                -- NULL ALONE — so a zero, negative or NaN override IS the number that reached the
                -- estimate. Such a line was not fabricated as one unit, and this remediation's text
                -- would be false about it. It may be broken for its own reason; that is a different
                -- claim, and no path ORIGINATES a non-null override_quantity today — the insert in
                -- recommendation-persistence-service.ts writes NULL, and the two carry-forward inserts
                -- in draft-estimate-service.ts only copy an existing value — so it is not a claim this
                -- migration should invent. Every non-null override quantity is excluded here.
                AND r.source_type IS DISTINCT FROM 'manual'
                AND NOT (
                  r.selected_source_type = 'override'
                  AND r.override_quantity IS NOT NULL
                )
                AND (
                  e.quantity IS NULL
                  OR e.quantity <= 0
                  OR e.quantity = 'NaN'::numeric
                )
                -- AND THE LINE MUST STILL CARRY THE NUMBER PROMOTION GAVE IT. `updateLineItem`
                -- (deals/estimate-service.ts) rewrites a line's quantity and recalculates its total but
                -- never clears `promoted_estimate_line_item_id`, so the join above survives a
                -- correction while the source extraction stays unpriceable forever. Without this, an
                -- estimator who has ALREADY fixed a line is told in their own queue that it "was priced
                -- as ONE UNIT" and asked to re-price or void it — a false task about finished work,
                -- which is the fastest way to teach somebody the queue is noise.
                --
                -- `COALESCE(recommended_quantity, 1)` is exactly what promotion wrote:
                -- resolvePromotionLineValues takes the recommendation's quantity and falls back to one
                -- unit when it is null. Written against the column rather than the literal 1 because a
                -- recommendation that DID carry a quantity promoted THAT number, and pinning only the
                -- 1 case would let an untouched non-1 line escape the remediation it needs.
                AND li.quantity = COALESCE(r.recommended_quantity, 1)
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

    -- LEGACY APPROVED ROWS, WHICH THE MOVE ABOVE CANNOT TOUCH.
    --
    -- The UPDATE parks `processed` rows only, deliberately: `approved` is somebody's decision and a
    -- migration must not overwrite it at deploy time. But that leaves a real set with no signal
    -- ANYWHERE. An extraction approved before this deploy, carrying a null, zero, negative or NaN
    -- quantity, is now: refused by the promote predicate (its recommendation was built from a quantity
    -- that is not there), skipped by the worker (which reselects ordinary rows at `pending`), and
    -- absent from `summary.extractions.needsQuantity` (which counts that one status). Three surfaces
    -- agree it needs attention and none of them says so.
    --
    -- SURFACED, NOT MOVED — the same rule the promoted-line remediation above follows, for the same
    -- reason: an event is additive and reversible, a status change silently discards a human decision
    -- for a whole class of rows at once. The event names the extraction rather than a line item, so it
    -- cannot collide with the remediation written above even on a row that is both.
    --
    -- Guarded on both relations it touches. `estimate_extractions` is proven by the CONTINUE at the top
    -- of the loop; `estimate_review_events` is not.
    IF to_regclass(format('%I.estimate_review_events', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        $legacy$INSERT INTO %I.estimate_review_events
                  (deal_id, subject_type, subject_id, event_type, before_json, after_json, reason, user_id)
                SELECT e.deal_id,
                       'estimate_extraction',
                       e.id,
                       'remediation_required',
                       jsonb_build_object('status', e.status, 'quantity', e.quantity),
                       '{}'::jsonb,
                       'Migration 0215: this extraction was APPROVED with no usable quantity ('
                         || COALESCE(e.quantity::text, 'none') || '). Its review decision has been left '
                         || 'alone. It is absent from the needs-quantity bucket, and the generation job '
                         || 'only re-prices ordinary rows at pending, so nothing will revisit it on its '
                         || 'own. If a manual row or a quantity-carrying override is anchored to it, it '
                         || 'may still price correctly — check before acting. Otherwise supply the '
                         || 'quantity to put it back in the queue.',
                       NULL
                  FROM %I.estimate_extractions e
                 WHERE e.status = 'approved'
                   AND (
                     e.quantity IS NULL
                     OR e.quantity <= 0
                     OR e.quantity = 'NaN'::numeric
                   )
                   -- MEASUREMENT CANDIDATES ARE NOT STRANDED. The worker selects them on
                   -- extraction_type regardless of status, so one with no quantity is re-examined on
                   -- the next run by design. Flagging it would be a false task about a working path.
                   AND e.extraction_type IS DISTINCT FROM 'measurement_candidate'
                   -- AND ONLY THE ACTIVE ARTIFACT. A superseded extraction is hidden by the workbench
                   -- (it filters rows by active artifact) while review events are returned UNFILTERED,
                   -- so flagging one produces an action request for a row that is not on the
                   -- estimator's screen — the same defect this migration's worker change fixes.
                   AND e.metadata_json->>'activeArtifact' = 'true'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM %I.estimate_review_events x
                      WHERE x.subject_type = 'estimate_extraction'
                        AND x.subject_id = e.id
                        AND x.event_type = 'remediation_required'
                   )$legacy$,
        schema_name, schema_name, schema_name
      );
      GET DIAGNOSTICS surfaced = ROW_COUNT;
      RAISE NOTICE '0215: % approved extraction(s) surfaced as needing a quantity in %', surfaced, schema_name;
    END IF;

    -- Said out loud per office. A silent backfill of pricing state is exactly the kind of change
    -- somebody needs to be able to find in a deploy log six weeks later.
    RAISE NOTICE '0215: % extraction(s) moved to needs_quantity in %', moved, schema_name;
  END LOOP;
END $tenant$;
