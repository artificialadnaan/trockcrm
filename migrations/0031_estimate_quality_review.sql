-- Migration 0031: Add estimate quality recommendation storage

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.estimate_pricing_recommendations
         ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES %I.estimate_source_documents(id) ON DELETE SET NULL,
         ADD COLUMN IF NOT EXISTS source_extraction_id UUID REFERENCES %I.estimate_extractions(id) ON DELETE SET NULL,
         ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT ''extracted'',
         ADD COLUMN IF NOT EXISTS normalized_intent TEXT,
         ADD COLUMN IF NOT EXISTS source_row_identity TEXT,
         ADD COLUMN IF NOT EXISTS generation_run_id UUID REFERENCES %I.estimate_generation_runs(id) ON DELETE CASCADE,
         ADD COLUMN IF NOT EXISTS manual_origin TEXT,
         ADD COLUMN IF NOT EXISTS selected_source_type TEXT,
         ADD COLUMN IF NOT EXISTS selected_option_id UUID,
         ADD COLUMN IF NOT EXISTS catalog_backing TEXT,
         ADD COLUMN IF NOT EXISTS promoted_local_catalog_item_id UUID,
         ADD COLUMN IF NOT EXISTS promoted_estimate_line_item_id UUID REFERENCES %I.estimate_line_items(id) ON DELETE SET NULL,
         ADD COLUMN IF NOT EXISTS manual_label TEXT,
         ADD COLUMN IF NOT EXISTS manual_identity_key TEXT,
         ADD COLUMN IF NOT EXISTS manual_quantity NUMERIC(14, 3),
         ADD COLUMN IF NOT EXISTS manual_unit VARCHAR(50),
         ADD COLUMN IF NOT EXISTS manual_unit_price NUMERIC(14, 2),
         ADD COLUMN IF NOT EXISTS manual_notes TEXT,
         ADD COLUMN IF NOT EXISTS override_quantity NUMERIC(14, 3),
         ADD COLUMN IF NOT EXISTS override_unit VARCHAR(50),
         ADD COLUMN IF NOT EXISTS override_unit_price NUMERIC(14, 2),
         ADD COLUMN IF NOT EXISTS override_notes TEXT',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.estimate_pricing_recommendations AS recommendations
          SET normalized_intent = COALESCE(extractions.normalized_label, extractions.raw_label, recommendations.source_row_identity, ''''),
              source_row_identity = COALESCE(
                recommendations.source_row_identity,
                ''extraction:'' || recommendations.extraction_match_id::text
              )
         FROM %I.estimate_extraction_matches AS matches
         LEFT JOIN %I.estimate_extractions AS extractions
           ON extractions.id = matches.extraction_id
        WHERE recommendations.extraction_match_id = matches.id
          AND (recommendations.normalized_intent IS NULL OR recommendations.source_row_identity IS NULL)',
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.estimate_pricing_recommendations
          SET normalized_intent = COALESCE(normalized_intent, ''''),
              source_row_identity = COALESCE(source_row_identity, ''extraction:'' || extraction_match_id::text),
              source_type = COALESCE(source_type, ''extracted'')
        WHERE normalized_intent IS NULL
           OR source_row_identity IS NULL
           OR source_type IS NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_pricing_recommendations
         ALTER COLUMN source_type SET DEFAULT ''extracted'',
         ALTER COLUMN source_type SET NOT NULL,
         ALTER COLUMN normalized_intent SET NOT NULL,
         ALTER COLUMN source_row_identity SET NOT NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_pricing_recommendations
         DROP CONSTRAINT IF EXISTS estimate_pricing_recommendations_run_source_uidx',
      schema_name
    );

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.estimate_pricing_recommendations
           ADD CONSTRAINT estimate_pricing_recommendations_run_source_uidx
           UNIQUE (generation_run_id, source_row_identity)',
        schema_name
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_match_idx
         ON %I.estimate_pricing_recommendations (extraction_match_id, status)',
      schema_name
    );

    EXECUTE format(
      'DROP INDEX IF EXISTS %I.estimate_pricing_recommendations_run_idx',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_run_idx
         ON %I.estimate_pricing_recommendations (generation_run_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_pricing_recommendation_options (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         recommendation_id UUID NOT NULL REFERENCES %I.estimate_pricing_recommendations(id) ON DELETE CASCADE,
         catalog_item_id UUID,
         local_catalog_item_id UUID,
         rank INTEGER NOT NULL,
         option_label TEXT NOT NULL,
         option_kind TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT estimate_pricing_recommendation_options_rank_uidx UNIQUE (recommendation_id, rank)
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_pricing_recommendation_options_recommendation_idx
         ON %I.estimate_pricing_recommendation_options (recommendation_id)',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
ALTER TABLE estimate_pricing_recommendations
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES estimate_source_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_extraction_id UUID REFERENCES estimate_extractions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS normalized_intent TEXT,
  ADD COLUMN IF NOT EXISTS source_row_identity TEXT,
  ADD COLUMN IF NOT EXISTS generation_run_id UUID REFERENCES estimate_generation_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS manual_origin TEXT,
  ADD COLUMN IF NOT EXISTS selected_source_type TEXT,
  ADD COLUMN IF NOT EXISTS selected_option_id UUID,
  ADD COLUMN IF NOT EXISTS catalog_backing TEXT,
  ADD COLUMN IF NOT EXISTS promoted_local_catalog_item_id UUID,
  ADD COLUMN IF NOT EXISTS promoted_estimate_line_item_id UUID REFERENCES estimate_line_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_label TEXT,
  ADD COLUMN IF NOT EXISTS manual_identity_key TEXT,
  ADD COLUMN IF NOT EXISTS manual_quantity NUMERIC(14, 3),
  ADD COLUMN IF NOT EXISTS manual_unit VARCHAR(50),
  ADD COLUMN IF NOT EXISTS manual_unit_price NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS manual_notes TEXT,
  ADD COLUMN IF NOT EXISTS override_quantity NUMERIC(14, 3),
  ADD COLUMN IF NOT EXISTS override_unit VARCHAR(50),
  ADD COLUMN IF NOT EXISTS override_unit_price NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS override_notes TEXT;

UPDATE estimate_pricing_recommendations AS recommendations
   SET normalized_intent = COALESCE(extractions.normalized_label, extractions.raw_label, recommendations.source_row_identity, ''),
       source_row_identity = COALESCE(
         recommendations.source_row_identity,
         'extraction:' || recommendations.extraction_match_id::text
       )
  FROM estimate_extraction_matches AS matches
  LEFT JOIN estimate_extractions AS extractions
    ON extractions.id = matches.extraction_id
 WHERE recommendations.extraction_match_id = matches.id
   AND (recommendations.normalized_intent IS NULL OR recommendations.source_row_identity IS NULL);

UPDATE estimate_pricing_recommendations
   SET normalized_intent = COALESCE(normalized_intent, ''),
       source_row_identity = COALESCE(source_row_identity, 'extraction:' || extraction_match_id::text),
       source_type = COALESCE(source_type, 'extracted')
 WHERE normalized_intent IS NULL
    OR source_row_identity IS NULL
    OR source_type IS NULL;

ALTER TABLE estimate_pricing_recommendations
  ALTER COLUMN source_type SET DEFAULT 'extracted',
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN normalized_intent SET NOT NULL,
  ALTER COLUMN source_row_identity SET NOT NULL;

ALTER TABLE estimate_pricing_recommendations
  DROP CONSTRAINT IF EXISTS estimate_pricing_recommendations_run_source_uidx;

ALTER TABLE estimate_pricing_recommendations
  ADD CONSTRAINT estimate_pricing_recommendations_run_source_uidx
  UNIQUE (generation_run_id, source_row_identity);

CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_match_idx
  ON estimate_pricing_recommendations (extraction_match_id, status);

DROP INDEX IF EXISTS estimate_pricing_recommendations_run_idx;

CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_run_idx
  ON estimate_pricing_recommendations (generation_run_id);

CREATE TABLE IF NOT EXISTS estimate_pricing_recommendation_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES estimate_pricing_recommendations(id) ON DELETE CASCADE,
  catalog_item_id UUID,
  local_catalog_item_id UUID,
  rank INTEGER NOT NULL,
  option_label TEXT NOT NULL,
  option_kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT estimate_pricing_recommendation_options_rank_uidx UNIQUE (recommendation_id, rank)
);

CREATE INDEX IF NOT EXISTS estimate_pricing_recommendation_options_recommendation_idx
  ON estimate_pricing_recommendation_options (recommendation_id);
-- TENANT_SCHEMA_END
