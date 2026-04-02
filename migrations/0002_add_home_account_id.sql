-- =============================================================================
-- Migration: Add home_account_id to user_graph_tokens
-- Supports per-user MSAL cache isolation (prevents token cross-contamination)
-- =============================================================================

ALTER TABLE user_graph_tokens
  ADD COLUMN IF NOT EXISTS home_account_id TEXT;
