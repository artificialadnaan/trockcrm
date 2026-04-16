-- Migration 0020: AI disconnect case workspace tables

CREATE TABLE IF NOT EXISTS ai_disconnect_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL,
  scope_type varchar(40) NOT NULL,
  scope_id uuid NOT NULL,
  deal_id uuid,
  company_id uuid,
  disconnect_type varchar(80) NOT NULL,
  cluster_key varchar(80),
  business_key varchar(255) NOT NULL,
  severity varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open',
  assigned_to uuid,
  generated_task_id uuid,
  escalated boolean NOT NULL DEFAULT false,
  snoozed_until timestamptz,
  reopen_count integer NOT NULL DEFAULT 0,
  first_detected_at timestamptz NOT NULL,
  last_detected_at timestamptz NOT NULL,
  last_intervened_at timestamptz,
  resolved_at timestamptz,
  resolution_reason varchar(80),
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_disconnect_cases_office_business_key_uidx
  ON ai_disconnect_cases (office_id, business_key);

CREATE INDEX IF NOT EXISTS ai_disconnect_cases_status_idx
  ON ai_disconnect_cases (status, escalated, assigned_to);

CREATE TABLE IF NOT EXISTS ai_disconnect_case_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disconnect_case_id uuid NOT NULL,
  action_type varchar(40) NOT NULL,
  acted_by uuid NOT NULL,
  acted_at timestamptz NOT NULL DEFAULT NOW(),
  from_status varchar(20),
  to_status varchar(20),
  from_assignee uuid,
  to_assignee uuid,
  from_snoozed_until timestamptz,
  to_snoozed_until timestamptz,
  notes text,
  metadata_json jsonb
);

CREATE INDEX IF NOT EXISTS ai_disconnect_case_history_case_idx
  ON ai_disconnect_case_history (disconnect_case_id, acted_at DESC);
