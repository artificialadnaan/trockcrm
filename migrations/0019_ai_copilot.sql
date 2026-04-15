-- Migration 0019: AI copilot foundation
-- Adds additive tenant-scoped tables for AI document indexing, embeddings,
-- copilot packets, task suggestions, risk flags, and feedback.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_document_index (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         source_type VARCHAR(64) NOT NULL,
         source_id UUID NOT NULL,
         company_id UUID,
         property_id UUID,
         lead_id UUID,
         deal_id UUID,
         index_status VARCHAR(32) NOT NULL DEFAULT ''pending'',
         content_hash VARCHAR(128),
         metadata_json JSONB,
         indexed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_document_index_source_idx
         ON %I.ai_document_index (source_type, source_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_document_index_deal_idx
         ON %I.ai_document_index (deal_id, index_status)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_embedding_chunks (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         document_id UUID NOT NULL REFERENCES %I.ai_document_index(id) ON DELETE CASCADE,
         chunk_index INTEGER NOT NULL,
         text TEXT NOT NULL,
         embedding vector(1536),
         token_count INTEGER,
         metadata_json JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name, schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_embedding_chunks_document_idx
         ON %I.ai_embedding_chunks (document_id, chunk_index)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_embedding_chunks_embedding_ivfflat_idx
         ON %I.ai_embedding_chunks
         USING ivfflat (embedding vector_cosine_ops)
         WITH (lists = 100)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_copilot_packets (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         scope_type VARCHAR(32) NOT NULL,
         scope_id UUID NOT NULL,
         deal_id UUID,
         packet_kind VARCHAR(32) NOT NULL,
         snapshot_hash VARCHAR(128) NOT NULL,
         model_name VARCHAR(100),
         status VARCHAR(32) NOT NULL DEFAULT ''pending'',
         summary_text TEXT,
         next_step_json JSONB,
         blind_spots_json JSONB,
         evidence_json JSONB,
         confidence NUMERIC(5,4),
         generated_at TIMESTAMPTZ,
         expires_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_copilot_packets_scope_idx
         ON %I.ai_copilot_packets (scope_type, scope_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_copilot_packets_deal_idx
         ON %I.ai_copilot_packets (deal_id, generated_at DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_task_suggestions (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         packet_id UUID NOT NULL REFERENCES %I.ai_copilot_packets(id) ON DELETE CASCADE,
         scope_type VARCHAR(32) NOT NULL,
         scope_id UUID NOT NULL,
         title VARCHAR(500) NOT NULL,
         description TEXT,
         suggested_owner_id UUID,
         suggested_due_at TIMESTAMPTZ,
         priority VARCHAR(32) NOT NULL DEFAULT ''normal'',
         confidence NUMERIC(5,4),
         evidence_json JSONB,
         status VARCHAR(32) NOT NULL DEFAULT ''suggested'',
         accepted_task_id UUID,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         resolved_at TIMESTAMPTZ
       )',
      schema_name, schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_task_suggestions_scope_idx
         ON %I.ai_task_suggestions (scope_type, scope_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_task_suggestions_packet_idx
         ON %I.ai_task_suggestions (packet_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_risk_flags (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         packet_id UUID REFERENCES %I.ai_copilot_packets(id) ON DELETE SET NULL,
         scope_type VARCHAR(32) NOT NULL,
         scope_id UUID NOT NULL,
         deal_id UUID,
         flag_type VARCHAR(64) NOT NULL,
         severity VARCHAR(16) NOT NULL,
         status VARCHAR(32) NOT NULL DEFAULT ''open'',
         title VARCHAR(500) NOT NULL,
         details TEXT,
         evidence_json JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         resolved_at TIMESTAMPTZ
       )',
      schema_name, schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_risk_flags_scope_idx
         ON %I.ai_risk_flags (scope_type, scope_id, status)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_risk_flags_deal_idx
         ON %I.ai_risk_flags (deal_id, severity)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_feedback (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         target_type VARCHAR(32) NOT NULL,
         target_id UUID NOT NULL,
         user_id UUID NOT NULL REFERENCES public.users(id),
         feedback_type VARCHAR(32) NOT NULL,
         feedback_value VARCHAR(32) NOT NULL,
         comment TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_feedback_target_idx
         ON %I.ai_feedback (target_type, target_id, created_at DESC)',
      schema_name
    );
  END LOOP;
END $$;
