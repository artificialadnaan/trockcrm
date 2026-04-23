CREATE TABLE IF NOT EXISTS public.cost_catalog_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_account_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_synced_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  default_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cost_catalog_sources_provider_idx
  ON public.cost_catalog_sources (provider, status);

CREATE TABLE IF NOT EXISTS public.cost_catalog_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_upserted INTEGER NOT NULL DEFAULT 0,
  items_deactivated INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cost_catalog_sync_runs_source_idx
  ON public.cost_catalog_sync_runs (source_id, started_at);

CREATE TABLE IF NOT EXISTS public.cost_catalog_snapshot_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  sync_run_id UUID NOT NULL REFERENCES public.cost_catalog_sync_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'staged',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cost_catalog_snapshot_versions_source_idx
  ON public.cost_catalog_snapshot_versions (source_id, created_at);

CREATE TABLE IF NOT EXISTS public.cost_catalog_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  snapshot_version_id UUID REFERENCES public.cost_catalog_snapshot_versions(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_code_id UUID,
  division TEXT,
  phase_name TEXT,
  phase_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cost_catalog_codes_source_external_unique UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS cost_catalog_codes_code_idx
  ON public.cost_catalog_codes (source_id, code);

CREATE TABLE IF NOT EXISTS public.cost_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  snapshot_version_id UUID REFERENCES public.cost_catalog_snapshot_versions(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit VARCHAR(50),
  catalog_name TEXT,
  catalog_number TEXT,
  manufacturer TEXT,
  supplier TEXT,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cost_catalog_items_source_external_unique UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS cost_catalog_items_name_idx
  ON public.cost_catalog_items (source_id, name);

CREATE TABLE IF NOT EXISTS public.cost_catalog_item_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES public.cost_catalog_items(id) ON DELETE CASCADE,
  catalog_code_id UUID NOT NULL REFERENCES public.cost_catalog_codes(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT cost_catalog_item_codes_unique UNIQUE (catalog_item_id, catalog_code_id)
);

CREATE INDEX IF NOT EXISTS cost_catalog_item_codes_primary_idx
  ON public.cost_catalog_item_codes (catalog_item_id, is_primary);

CREATE TABLE IF NOT EXISTS public.cost_catalog_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES public.cost_catalog_items(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  sync_run_id UUID REFERENCES public.cost_catalog_sync_runs(id) ON DELETE SET NULL,
  snapshot_version_id UUID REFERENCES public.cost_catalog_snapshot_versions(id) ON DELETE SET NULL,
  material_unit_cost NUMERIC(14, 2),
  labor_unit_cost NUMERIC(14, 2),
  equipment_unit_cost NUMERIC(14, 2),
  subcontract_unit_cost NUMERIC(14, 2),
  blended_unit_cost NUMERIC(14, 2),
  effective_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cost_catalog_prices_item_idx
  ON public.cost_catalog_prices (catalog_item_id, effective_at);

CREATE INDEX IF NOT EXISTS cost_catalog_prices_snapshot_idx
  ON public.cost_catalog_prices (snapshot_version_id);

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
      'CREATE TABLE IF NOT EXISTS %I.estimate_source_documents (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         project_id UUID,
         file_id UUID NOT NULL,
         root_file_id UUID,
         document_type TEXT NOT NULL,
         filename TEXT NOT NULL,
         storage_key TEXT,
         mime_type VARCHAR(255) NOT NULL,
         file_size BIGINT,
         version_label VARCHAR(100),
         uploaded_by_user_id UUID,
         content_hash TEXT,
         ocr_status TEXT NOT NULL DEFAULT ''queued'',
         parsed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_source_documents_deal_idx
         ON %I.estimate_source_documents (deal_id, created_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_source_documents_file_idx
         ON %I.estimate_source_documents (file_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_document_pages (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         document_id UUID NOT NULL REFERENCES %I.estimate_source_documents(id) ON DELETE CASCADE,
         page_number INTEGER NOT NULL,
         sheet_label TEXT,
         sheet_type TEXT,
         ocr_text TEXT,
         page_image_key TEXT,
         metadata_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_document_pages_document_idx
         ON %I.estimate_document_pages (document_id, page_number)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_generation_runs (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         project_id UUID,
         status TEXT NOT NULL DEFAULT ''pending'',
         triggered_by_user_id UUID,
         input_snapshot_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         output_summary_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         error_summary TEXT,
         started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at TIMESTAMPTZ,
         catalog_sync_run_id UUID,
         catalog_snapshot_version_id UUID
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_generation_runs_deal_idx
         ON %I.estimate_generation_runs (deal_id, started_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_extractions (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         project_id UUID,
         document_id UUID NOT NULL REFERENCES %I.estimate_source_documents(id) ON DELETE CASCADE,
         page_id UUID REFERENCES %I.estimate_document_pages(id) ON DELETE SET NULL,
         extraction_type TEXT NOT NULL,
         raw_label TEXT NOT NULL,
         normalized_label TEXT NOT NULL,
         quantity NUMERIC(14, 3),
         unit VARCHAR(50),
         division_hint TEXT,
         confidence NUMERIC(5, 2) NOT NULL DEFAULT 0,
         evidence_text TEXT,
         evidence_bbox_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         metadata_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         status TEXT NOT NULL DEFAULT ''pending'',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_extractions_document_idx
         ON %I.estimate_extractions (document_id, created_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_extractions_deal_idx
         ON %I.estimate_extractions (deal_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_extraction_matches (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         extraction_id UUID NOT NULL REFERENCES %I.estimate_extractions(id) ON DELETE CASCADE,
         catalog_item_id UUID,
         catalog_code_id UUID,
         historical_line_item_id UUID REFERENCES %I.estimate_line_items(id) ON DELETE SET NULL,
         match_type TEXT NOT NULL,
         match_score NUMERIC(5, 2) NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT ''suggested'',
         reason_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         evidence_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_extraction_matches_extraction_idx
         ON %I.estimate_extraction_matches (extraction_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_pricing_recommendations (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         project_id UUID,
         extraction_match_id UUID NOT NULL REFERENCES %I.estimate_extraction_matches(id) ON DELETE CASCADE,
         recommended_quantity NUMERIC(14, 3),
         recommended_unit VARCHAR(50),
         recommended_unit_price NUMERIC(14, 2),
         recommended_total_price NUMERIC(14, 2),
         price_basis TEXT NOT NULL,
         catalog_baseline_price NUMERIC(14, 2),
         historical_median_price NUMERIC(14, 2),
         market_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
         confidence NUMERIC(5, 2) NOT NULL DEFAULT 0,
         assumptions_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         evidence_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         created_by_run_id UUID REFERENCES %I.estimate_generation_runs(id) ON DELETE SET NULL,
         status TEXT NOT NULL DEFAULT ''pending'',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_match_idx
         ON %I.estimate_pricing_recommendations (extraction_match_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_pricing_recommendations_run_idx
         ON %I.estimate_pricing_recommendations (created_by_run_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_review_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         project_id UUID,
         subject_type TEXT NOT NULL,
         subject_id UUID NOT NULL,
         event_type TEXT NOT NULL,
         before_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         after_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         reason TEXT,
         user_id UUID,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_review_events_deal_idx
         ON %I.estimate_review_events (deal_id, created_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_review_events_subject_idx
         ON %I.estimate_review_events (subject_type, subject_id)',
      schema_name
    );
  END LOOP;
END $$;
