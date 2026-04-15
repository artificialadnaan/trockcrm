-- Migration 0023: Migration exception staging tables

CREATE SCHEMA IF NOT EXISTS migration;

CREATE TABLE IF NOT EXISTS migration.staged_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid,
  import_run_id uuid,
  hubspot_company_id varchar(100) UNIQUE NOT NULL,
  raw_data jsonb NOT NULL,
  mapped_name varchar(500),
  mapped_domain varchar(255),
  mapped_phone varchar(50),
  mapped_owner_email varchar(255),
  mapped_lead_hint varchar(255),
  validation_status varchar(50) NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  exception_bucket varchar(100),
  exception_reason text,
  reviewed_by uuid,
  review_notes text,
  promoted_at timestamptz,
  promoted_company_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staged_companies_office_id_idx
  ON migration.staged_companies (office_id);

CREATE INDEX IF NOT EXISTS staged_companies_validation_status_idx
  ON migration.staged_companies (validation_status);

CREATE INDEX IF NOT EXISTS staged_companies_exception_bucket_idx
  ON migration.staged_companies (exception_bucket)
  WHERE exception_bucket IS NOT NULL;

CREATE TABLE IF NOT EXISTS migration.staged_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid,
  import_run_id uuid,
  hubspot_property_id varchar(100) UNIQUE NOT NULL,
  raw_data jsonb NOT NULL,
  mapped_name varchar(500),
  mapped_company_name varchar(500),
  mapped_company_domain varchar(255),
  mapped_address varchar(500),
  mapped_city varchar(255),
  mapped_state varchar(100),
  mapped_zip varchar(20),
  candidate_company_count integer NOT NULL DEFAULT 0,
  mapped_owner_email varchar(255),
  validation_status varchar(50) NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  exception_bucket varchar(100),
  exception_reason text,
  reviewed_by uuid,
  review_notes text,
  promoted_at timestamptz,
  promoted_property_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staged_properties_office_id_idx
  ON migration.staged_properties (office_id);

CREATE INDEX IF NOT EXISTS staged_properties_validation_status_idx
  ON migration.staged_properties (validation_status);

CREATE INDEX IF NOT EXISTS staged_properties_exception_bucket_idx
  ON migration.staged_properties (exception_bucket)
  WHERE exception_bucket IS NOT NULL;

CREATE TABLE IF NOT EXISTS migration.staged_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid,
  import_run_id uuid,
  hubspot_lead_id varchar(100) UNIQUE NOT NULL,
  raw_data jsonb NOT NULL,
  mapped_name varchar(500),
  mapped_company_name varchar(500),
  mapped_property_name varchar(500),
  mapped_deal_name varchar(500),
  candidate_deal_count integer NOT NULL DEFAULT 0,
  candidate_property_count integer NOT NULL DEFAULT 0,
  mapped_owner_email varchar(255),
  mapped_source_stage varchar(100),
  mapped_amount numeric(14,2),
  mapped_close_date date,
  validation_status varchar(50) NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  exception_bucket varchar(100),
  exception_reason text,
  reviewed_by uuid,
  review_notes text,
  promoted_at timestamptz,
  promoted_lead_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staged_leads_office_id_idx
  ON migration.staged_leads (office_id);

CREATE INDEX IF NOT EXISTS staged_leads_validation_status_idx
  ON migration.staged_leads (validation_status);

CREATE INDEX IF NOT EXISTS staged_leads_exception_bucket_idx
  ON migration.staged_leads (exception_bucket)
  WHERE exception_bucket IS NOT NULL;
