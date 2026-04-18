-- =============================================================================
-- T Rock CRM — Initial Migration
-- Creates all enums, public tables, trigger functions, default tenant schema,
-- and seed data.
-- =============================================================================

-- =============================================================================
-- SECTION 1: ENUMS (idempotent)
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'director', 'rep');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE graph_token_status AS ENUM ('active', 'expired', 'revoked', 'reauth_needed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sync_direction AS ENUM ('crm_to_procore', 'procore_to_crm', 'bidirectional');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sync_status AS ENUM ('synced', 'pending', 'conflict', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_visibility AS ENUM ('private', 'office', 'company');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE procore_entity_type AS ENUM ('project', 'bid', 'change_order', 'contact');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_entity AS ENUM ('deals', 'contacts', 'activities', 'tasks');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE change_order_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE contact_category AS ENUM ('client', 'subcontractor', 'architect', 'property_manager', 'regional_manager', 'vendor', 'consultant', 'influencer', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE activity_type AS ENUM ('call', 'note', 'meeting', 'email', 'task_completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE file_category AS ENUM ('photo', 'contract', 'rfp', 'estimate', 'change_order', 'proposal', 'permit', 'inspection', 'correspondence', 'insurance', 'warranty', 'closeout', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_type AS ENUM ('follow_up', 'stale_deal', 'inbound_email', 'approval_request', 'touchpoint', 'manual', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_priority AS ENUM ('urgent', 'high', 'normal', 'low');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('pending', 'in_progress', 'completed', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('stale_deal', 'inbound_email', 'task_assigned', 'approval_needed', 'activity_drop', 'deal_won', 'deal_lost', 'stage_change', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE email_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE duplicate_match_type AS ENUM ('exact_email', 'fuzzy_name', 'fuzzy_phone', 'company_match');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE duplicate_status AS ENUM ('pending', 'merged', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('insert', 'update', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- SECTION 2: PUBLIC SCHEMA TABLES
-- =============================================================================

-- Migration tracking table
CREATE TABLE IF NOT EXISTS _migrations (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(255) UNIQUE NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offices
CREATE TABLE IF NOT EXISTS offices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) UNIQUE NOT NULL,
  address    TEXT,
  phone      VARCHAR(20),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  settings   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              VARCHAR(255) UNIQUE NOT NULL,
  display_name       VARCHAR(255) NOT NULL,
  azure_ad_id        VARCHAR(255) UNIQUE,
  avatar_url         TEXT,
  role               user_role NOT NULL,
  office_id          UUID NOT NULL REFERENCES offices(id),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  notification_prefs JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User office access (multi-office support)
CREATE TABLE IF NOT EXISTS user_office_access (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  office_id     UUID NOT NULL REFERENCES offices(id),
  role_override user_role,
  UNIQUE (user_id, office_id)
);

-- Pipeline stage configuration
CREATE TABLE IF NOT EXISTS pipeline_stage_config (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(100) NOT NULL,
  slug                   VARCHAR(100) UNIQUE NOT NULL,
  display_order          INTEGER NOT NULL,
  is_active_pipeline     BOOLEAN NOT NULL DEFAULT TRUE,
  is_terminal            BOOLEAN NOT NULL DEFAULT FALSE,
  required_fields        JSONB NOT NULL DEFAULT '[]',
  required_documents     JSONB NOT NULL DEFAULT '[]',
  required_approvals     JSONB NOT NULL DEFAULT '[]',
  stale_threshold_days   INTEGER,
  procore_stage_mapping  VARCHAR(100),
  color                  VARCHAR(7)
);

-- Lost deal reasons
CREATE TABLE IF NOT EXISTS lost_deal_reasons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         VARCHAR(255) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL
);

-- Project type configuration (hierarchical via parent_id)
CREATE TABLE IF NOT EXISTS project_type_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  parent_id     UUID REFERENCES project_type_config(id),
  display_order INTEGER NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- Region configuration
CREATE TABLE IF NOT EXISTS region_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  states        TEXT[] NOT NULL,
  display_order INTEGER NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- Saved reports
CREATE TABLE IF NOT EXISTS saved_reports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  entity     report_entity NOT NULL,
  config     JSONB NOT NULL,
  is_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  office_id  UUID REFERENCES offices(id),
  visibility report_visibility NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Procore sync state (maps Procore entities to CRM entities)
CREATE TABLE IF NOT EXISTS procore_sync_state (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type             procore_entity_type NOT NULL,
  procore_id              BIGINT NOT NULL,
  crm_entity_type         VARCHAR(50) NOT NULL,
  crm_entity_id           UUID NOT NULL,
  office_id               UUID NOT NULL REFERENCES offices(id),
  sync_direction           sync_direction NOT NULL,
  last_synced_at          TIMESTAMPTZ,
  last_procore_updated_at TIMESTAMPTZ,
  last_crm_updated_at     TIMESTAMPTZ,
  sync_status             sync_status NOT NULL DEFAULT 'synced',
  conflict_data           JSONB,
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, procore_id, office_id)
);

CREATE INDEX IF NOT EXISTS procore_sync_out_of_sync_idx
  ON procore_sync_state (sync_status) WHERE sync_status != 'synced';

-- Procore webhook log
CREATE TABLE IF NOT EXISTS procore_webhook_log (
  id            BIGSERIAL PRIMARY KEY,
  event_type    VARCHAR(100) NOT NULL,
  resource_id   BIGINT NOT NULL,
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at  TIMESTAMPTZ,
  error_message TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_unprocessed_idx
  ON procore_webhook_log (processed, received_at);

-- User Graph (Azure AD / Outlook) tokens
CREATE TABLE IF NOT EXISTS user_graph_tokens (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL UNIQUE REFERENCES users(id),
  access_token              TEXT NOT NULL,
  refresh_token             TEXT NOT NULL,
  token_expires_at          TIMESTAMPTZ NOT NULL,
  scopes                    TEXT[] NOT NULL,
  subscription_id           VARCHAR(255),
  subscription_expires_at   TIMESTAMPTZ,
  last_delta_link           TEXT,
  status                    graph_token_status NOT NULL DEFAULT 'active',
  last_sync_at              TIMESTAMPTZ,
  error_message             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Job queue (background tasks)
CREATE TABLE IF NOT EXISTS job_queue (
  id                    BIGSERIAL PRIMARY KEY,
  job_type              VARCHAR(100) NOT NULL,
  payload               JSONB NOT NULL,
  office_id             UUID REFERENCES offices(id),
  status                job_status NOT NULL DEFAULT 'pending',
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 3,
  last_error            TEXT,
  started_processing_at TIMESTAMPTZ,
  run_after             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS job_queue_pending_idx
  ON job_queue (status, run_after) WHERE status = 'pending';

-- =============================================================================
-- SECTION 3: SHARED TRIGGER FUNCTIONS
-- =============================================================================

-- Audit trigger: records INSERT/UPDATE/DELETE into the schema's audit_log table
CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
DECLARE
  changed_fields JSONB := '{}';
  col_name TEXT;
  old_val TEXT;
  new_val TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format(
      'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, full_row, created_at)
       VALUES ($1, $2, $3::public.audit_action, $4, $5, NOW())',
      TG_TABLE_SCHEMA
    )
    USING
      TG_TABLE_NAME,
      NEW.id,
      'insert',
      NULLIF(current_setting('app.current_user_id', true), '')::UUID,
      to_jsonb(NEW);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR col_name IN SELECT column_name FROM information_schema.columns
      WHERE table_schema = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME
    LOOP
      EXECUTE format('SELECT ($1).%I::TEXT, ($2).%I::TEXT', col_name, col_name)
        INTO old_val, new_val USING OLD, NEW;
      IF old_val IS DISTINCT FROM new_val THEN
        changed_fields := changed_fields || jsonb_build_object(
          col_name, jsonb_build_object('old', old_val, 'new', new_val)
        );
      END IF;
    END LOOP;
    IF changed_fields != '{}' THEN
      EXECUTE format(
        'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, changes, created_at)
         VALUES ($1, $2, $3::public.audit_action, $4, $5, NOW())',
        TG_TABLE_SCHEMA
      )
      USING
        TG_TABLE_NAME,
        NEW.id,
        'update',
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        changed_fields;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, full_row, created_at)
       VALUES ($1, $2, $3::public.audit_action, $4, $5, NOW())',
      TG_TABLE_SCHEMA
    )
    USING
      TG_TABLE_NAME,
      OLD.id,
      'delete',
      NULLIF(current_setting('app.current_user_id', true), '')::UUID,
      to_jsonb(OLD);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Updated-at trigger: automatically sets updated_at = NOW() on UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- SECTION 4: updated_at TRIGGERS ON PUBLIC TABLES
-- =============================================================================

DO $$ BEGIN
  CREATE TRIGGER set_offices_updated_at
    BEFORE UPDATE ON offices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_saved_reports_updated_at
    BEFORE UPDATE ON saved_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_procore_sync_state_updated_at
    BEFORE UPDATE ON procore_sync_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_user_graph_tokens_updated_at
    BEFORE UPDATE ON user_graph_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- SECTION 5: TENANT SCHEMA (default office: office_dallas)
-- =============================================================================

-- TENANT_SCHEMA_START
-- Everything between these markers is re-run for each new office schema.
-- The placeholder 'office_dallas' is replaced with the actual schema name.

CREATE SCHEMA IF NOT EXISTS office_dallas;
SET search_path = 'office_dallas', 'public';

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_number           VARCHAR(50) UNIQUE NOT NULL,
  name                  VARCHAR(500) NOT NULL,
  stage_id              UUID NOT NULL REFERENCES public.pipeline_stage_config(id),
  assigned_rep_id       UUID NOT NULL REFERENCES public.users(id),
  primary_contact_id    UUID,
  dd_estimate           NUMERIC(14,2),
  bid_estimate          NUMERIC(14,2),
  awarded_amount        NUMERIC(14,2),
  change_order_total    NUMERIC(14,2) DEFAULT 0,
  description           TEXT,
  property_address      TEXT,
  property_city         VARCHAR(255),
  property_state        VARCHAR(2),
  property_zip          VARCHAR(10),
  project_type_id       UUID REFERENCES public.project_type_config(id),
  region_id             UUID REFERENCES public.region_config(id),
  source                VARCHAR(100),
  win_probability       INTEGER,
  procore_project_id    BIGINT,
  procore_bid_id        BIGINT,
  procore_last_synced_at TIMESTAMPTZ,
  lost_reason_id        UUID REFERENCES public.lost_deal_reasons(id),
  lost_notes            TEXT,
  lost_competitor       VARCHAR(255),
  lost_at               TIMESTAMPTZ,
  expected_close_date   DATE,
  actual_close_date     DATE,
  last_activity_at      TIMESTAMPTZ,
  stage_entered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  hubspot_deal_id       VARCHAR(50),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Deal stage history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                   UUID NOT NULL REFERENCES deals(id),
  from_stage_id             UUID REFERENCES public.pipeline_stage_config(id),
  to_stage_id               UUID NOT NULL REFERENCES public.pipeline_stage_config(id),
  changed_by                UUID NOT NULL REFERENCES public.users(id),
  is_backward_move          BOOLEAN NOT NULL DEFAULT FALSE,
  is_director_override      BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason           TEXT,
  duration_in_previous_stage INTERVAL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Change orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      UUID NOT NULL REFERENCES deals(id),
  co_number    INTEGER NOT NULL,
  title        VARCHAR(500) NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  status       change_order_status NOT NULL DEFAULT 'pending',
  procore_co_id BIGINT,
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, co_number)
);

-- ---------------------------------------------------------------------------
-- Deal approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         UUID NOT NULL REFERENCES deals(id),
  target_stage_id UUID NOT NULL REFERENCES public.pipeline_stage_config(id),
  required_role   user_role NOT NULL,
  requested_by    UUID NOT NULL REFERENCES public.users(id),
  approved_by     UUID REFERENCES public.users(id),
  status          approval_status NOT NULL DEFAULT 'pending',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (deal_id, target_stage_id, required_role)
);

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name               VARCHAR(255) NOT NULL,
  last_name                VARCHAR(255) NOT NULL,
  email                    VARCHAR(255),
  phone                    VARCHAR(20),
  mobile                   VARCHAR(20),
  company_name             VARCHAR(500),
  job_title                VARCHAR(255),
  category                 contact_category NOT NULL,
  address                  TEXT,
  city                     VARCHAR(255),
  state                    VARCHAR(2),
  zip                      VARCHAR(10),
  notes                    TEXT,
  touchpoint_count         INTEGER NOT NULL DEFAULT 0,
  last_contacted_at        TIMESTAMPTZ,
  first_outreach_completed BOOLEAN NOT NULL DEFAULT FALSE,
  procore_contact_id       BIGINT,
  hubspot_contact_id       VARCHAR(50),
  normalized_phone         VARCHAR(20),
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only enforce uniqueness when email is not null
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique
  ON contacts (email) WHERE email IS NOT NULL;

-- Index for name/company lookups
CREATE INDEX IF NOT EXISTS contacts_name_company_idx
  ON contacts (company_name);

-- ---------------------------------------------------------------------------
-- Contact-deal associations (junction table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_deal_associations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  deal_id    UUID NOT NULL REFERENCES deals(id),
  role       VARCHAR(100),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id, deal_id)
);

-- ---------------------------------------------------------------------------
-- Duplicate queue (contact dedup)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_a_id     UUID NOT NULL REFERENCES contacts(id),
  contact_b_id     UUID NOT NULL REFERENCES contacts(id),
  match_type       duplicate_match_type NOT NULL,
  confidence_score NUMERIC(3,2),
  status           duplicate_status NOT NULL DEFAULT 'pending',
  resolved_by      UUID REFERENCES public.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  UNIQUE (contact_a_id, contact_b_id)
);

-- ---------------------------------------------------------------------------
-- Emails (synced from Outlook via Graph API)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_message_id       VARCHAR(500) UNIQUE NOT NULL,
  graph_conversation_id  VARCHAR(500),
  direction              email_direction NOT NULL,
  from_address           VARCHAR(255) NOT NULL,
  to_addresses           TEXT[] NOT NULL,
  cc_addresses           TEXT[],
  subject                VARCHAR(1000),
  body_preview           VARCHAR(500),
  body_html              TEXT,
  has_attachments        BOOLEAN NOT NULL DEFAULT FALSE,
  contact_id             UUID REFERENCES contacts(id),
  deal_id                UUID REFERENCES deals(id),
  user_id                UUID NOT NULL REFERENCES public.users(id),
  sent_at                TIMESTAMPTZ NOT NULL,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Activities (calls, notes, meetings, emails, task completions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             activity_type NOT NULL,
  user_id          UUID NOT NULL REFERENCES public.users(id),
  deal_id          UUID REFERENCES deals(id),
  contact_id       UUID REFERENCES contacts(id),
  email_id         UUID REFERENCES emails(id),
  subject          VARCHAR(500),
  body             TEXT,
  outcome          VARCHAR(100),
  duration_minutes INTEGER,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activities_user_idx
  ON activities (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS activities_deal_idx
  ON activities (deal_id, occurred_at);
CREATE INDEX IF NOT EXISTS activities_contact_idx
  ON activities (contact_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Files (R2-backed document storage)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category          file_category NOT NULL,
  subcategory       VARCHAR(100),
  folder_path       VARCHAR(1000),
  tags              TEXT[] NOT NULL DEFAULT '{}',
  display_name      VARCHAR(500) NOT NULL,
  system_filename   VARCHAR(500) NOT NULL,
  original_filename VARCHAR(500) NOT NULL,
  mime_type         VARCHAR(100) NOT NULL,
  file_size_bytes   BIGINT NOT NULL,
  file_extension    VARCHAR(20) NOT NULL,
  r2_key            VARCHAR(1000) UNIQUE NOT NULL,
  r2_bucket         VARCHAR(100) NOT NULL,
  deal_id           UUID REFERENCES deals(id),
  contact_id        UUID REFERENCES contacts(id),
  procore_project_id BIGINT,
  change_order_id   UUID REFERENCES change_orders(id),
  description       TEXT,
  notes             TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  parent_file_id    UUID REFERENCES files(id),
  taken_at          TIMESTAMPTZ,
  geo_lat           NUMERIC(10,7),
  geo_lng           NUMERIC(10,7),
  uploaded_by       UUID NOT NULL REFERENCES public.users(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector     TSVECTOR
);

-- CHECK: file must be associated with at least one entity
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_association_check;
ALTER TABLE files ADD CONSTRAINT files_association_check
  CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS files_deal_idx
  ON files (deal_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS files_folder_idx
  ON files (folder_path, display_name);
CREATE INDEX IF NOT EXISTS files_search_vector_idx
  ON files USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS files_tags_gin_idx
  ON files USING GIN (tags);
CREATE INDEX IF NOT EXISTS files_version_chain_idx
  ON files (parent_file_id, version) WHERE parent_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_photo_timeline_idx
  ON files (deal_id, category, COALESCE(taken_at, created_at) DESC)
  WHERE category = 'photo' AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS files_contact_idx
  ON files (contact_id, category, created_at DESC) WHERE contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        VARCHAR(500) NOT NULL,
  description  TEXT,
  type         task_type NOT NULL,
  priority     task_priority NOT NULL DEFAULT 'normal',
  status       task_status NOT NULL DEFAULT 'pending',
  assigned_to  UUID NOT NULL REFERENCES public.users(id),
  created_by   UUID REFERENCES public.users(id),
  deal_id      UUID REFERENCES deals(id),
  contact_id   UUID REFERENCES contacts(id),
  email_id     UUID REFERENCES emails(id),
  due_date     DATE,
  due_time     TIME,
  remind_at    TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  is_overdue   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_assigned_status_idx
  ON tasks (assigned_to, status, due_date);
CREATE INDEX IF NOT EXISTS tasks_priority_idx
  ON tasks (assigned_to, status, priority);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.users(id),
  type       notification_type NOT NULL,
  title      VARCHAR(500) NOT NULL,
  body       TEXT,
  link       VARCHAR(1000),
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, is_read, created_at);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  table_name  VARCHAR(100) NOT NULL,
  record_id   UUID NOT NULL,
  action      audit_action NOT NULL,
  changed_by  UUID,
  changes     JSONB,
  full_row    JSONB,
  ip_address  INET,
  user_agent  VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_record_idx
  ON audit_log (table_name, record_id, created_at);
CREATE INDEX IF NOT EXISTS audit_user_idx
  ON audit_log (changed_by, created_at);
CREATE INDEX IF NOT EXISTS audit_time_idx
  ON audit_log (created_at);

-- ---------------------------------------------------------------------------
-- TENANT TRIGGERS
-- ---------------------------------------------------------------------------

-- ---- Audit triggers on key tables ----

DO $$ BEGIN
  CREATE TRIGGER audit_deals
    AFTER INSERT OR UPDATE OR DELETE ON deals
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_contacts
    AFTER INSERT OR UPDATE OR DELETE ON contacts
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_change_orders
    AFTER INSERT OR UPDATE OR DELETE ON change_orders
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_deal_approvals
    AFTER INSERT OR UPDATE OR DELETE ON deal_approvals
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_emails
    AFTER INSERT OR UPDATE OR DELETE ON emails
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_activities
    AFTER INSERT OR UPDATE OR DELETE ON activities
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_files
    AFTER INSERT OR UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER audit_tasks
    AFTER INSERT OR UPDATE OR DELETE ON tasks
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- updated_at triggers ----

DO $$ BEGIN
  CREATE TRIGGER set_deals_updated_at
    BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_change_orders_updated_at
    BEFORE UPDATE ON change_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_contacts_updated_at
    BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_files_updated_at
    BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Search vector trigger for files (PG18: array_to_string is STABLE, not IMMUTABLE, so GENERATED ALWAYS AS won't work)
CREATE OR REPLACE FUNCTION files_search_vector_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.description, '') || ' ' || array_to_string(NEW.tags, ' ')), 'B') ||
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.notes, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER files_search_vector_update
    BEFORE INSERT OR UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION files_search_vector_trigger();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_tasks_updated_at
    BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- Change order total trigger ----
-- Recalculates deals.change_order_total from approved change orders

CREATE OR REPLACE FUNCTION recalc_change_order_total()
RETURNS TRIGGER AS $$
DECLARE
  target_deal_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_deal_id := OLD.deal_id;
  ELSE
    target_deal_id := NEW.deal_id;
  END IF;

  UPDATE deals
  SET change_order_total = COALESCE(
    (SELECT SUM(amount) FROM change_orders
     WHERE deal_id = target_deal_id AND status = 'approved'),
    0
  )
  WHERE id = target_deal_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER change_order_total_trigger
    AFTER INSERT OR UPDATE OR DELETE ON change_orders
    FOR EACH ROW EXECUTE FUNCTION recalc_change_order_total();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- Stage history trigger ----
-- Inserts a deal_stage_history row when deals.stage_id changes

CREATE OR REPLACE FUNCTION record_stage_history()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    INSERT INTO deal_stage_history (
      deal_id, from_stage_id, to_stage_id, changed_by,
      duration_in_previous_stage, created_at
    ) VALUES (
      NEW.id,
      OLD.stage_id,
      NEW.stage_id,
      COALESCE(NULLIF(current_setting('app.current_user_id', true), '')::UUID, NEW.assigned_rep_id),
      NOW() - OLD.stage_entered_at,
      NOW()
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DISABLED: stage_history_trigger creates duplicate rows because stage-change.ts
-- now explicitly inserts history with full override/backward/duration data.
-- See migration 0003_disable_stage_history_trigger.sql for details.
-- DO $$ BEGIN
--   CREATE TRIGGER stage_history_trigger
--     AFTER UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION record_stage_history();
-- EXCEPTION WHEN duplicate_object THEN NULL;
-- END $$;

-- ---- Stage entered_at trigger ----
-- Resets deals.stage_entered_at when stage_id changes

CREATE OR REPLACE FUNCTION reset_stage_entered_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    NEW.stage_entered_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER stage_entered_at_trigger
    BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION reset_stage_entered_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- Touchpoint trigger ----
-- Increments contacts.touchpoint_count on activities INSERT for call/email/meeting

CREATE OR REPLACE FUNCTION increment_touchpoint_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NEW.type IN ('call', 'email', 'meeting') THEN
    UPDATE contacts
    SET touchpoint_count = touchpoint_count + 1,
        last_contacted_at = NEW.occurred_at,
        first_outreach_completed = TRUE
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER touchpoint_trigger
    AFTER INSERT ON activities FOR EACH ROW EXECUTE FUNCTION increment_touchpoint_count();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- Normalized phone trigger ----
-- Strips non-digits from phone/mobile on INSERT/UPDATE

CREATE OR REPLACE FUNCTION normalize_phone_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.phone IS NOT NULL THEN
    NEW.normalized_phone = regexp_replace(NEW.phone, '\D', '', 'g');
  ELSIF NEW.mobile IS NOT NULL THEN
    NEW.normalized_phone = regexp_replace(NEW.mobile, '\D', '', 'g');
  ELSE
    NEW.normalized_phone = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER normalized_phone_trigger
    BEFORE INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION normalize_phone_fields();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Set primary_contact_id FK now that contacts table exists
-- (deals was created before contacts, so we add it as an ALTER)
DO $$ BEGIN
  ALTER TABLE deals ADD CONSTRAINT deals_primary_contact_fk
    FOREIGN KEY (primary_contact_id) REFERENCES contacts(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

RESET search_path;
-- TENANT_SCHEMA_END

-- =============================================================================
-- SECTION 6: SEED DATA
-- =============================================================================

-- Pipeline stages
INSERT INTO pipeline_stage_config (name, slug, display_order, is_active_pipeline, is_terminal, stale_threshold_days, color) VALUES
  ('Due Diligence', 'dd', 1, FALSE, FALSE, 90, '#6B7280'),
  ('Estimating', 'estimating', 2, TRUE, FALSE, 60, '#F59E0B'),
  ('Bid Sent', 'bid_sent', 3, TRUE, FALSE, 30, '#3B82F6'),
  ('In Production', 'in_production', 4, TRUE, FALSE, NULL, '#8B5CF6'),
  ('Close Out', 'close_out', 5, TRUE, FALSE, 30, '#06B6D4'),
  ('Closed Won', 'closed_won', 6, TRUE, TRUE, NULL, '#22C55E'),
  ('Closed Lost', 'closed_lost', 7, TRUE, TRUE, NULL, '#EF4444')
ON CONFLICT (slug) DO NOTHING;

-- Project types (top-level)
INSERT INTO project_type_config (name, slug, parent_id, display_order) VALUES
  ('Multifamily', 'multifamily', NULL, 1),
  ('Commercial', 'commercial', NULL, 2),
  ('Service', 'service', NULL, 3),
  ('Restoration', 'restoration', NULL, 4)
ON CONFLICT (slug) DO NOTHING;

-- Project sub-types (Multifamily children)
INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Traditional Multifamily', 'traditional_multifamily', id, 1
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Student Housing', 'student_housing', id, 2
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Senior Living', 'senior_living', id, 3
FROM project_type_config WHERE slug = 'multifamily'
ON CONFLICT (slug) DO NOTHING;

-- Project sub-types (Commercial children)
INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'New Construction', 'new_construction', id, 1
FROM project_type_config WHERE slug = 'commercial'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO project_type_config (name, slug, parent_id, display_order)
SELECT 'Land Development', 'land_development', id, 2
FROM project_type_config WHERE slug = 'commercial'
ON CONFLICT (slug) DO NOTHING;

-- Regions
INSERT INTO region_config (name, slug, states, display_order) VALUES
  ('Texas', 'texas', ARRAY['TX'], 1),
  ('East Coast', 'east_coast', ARRAY['NY', 'NJ', 'CT', 'PA', 'MA', 'VA', 'MD', 'DC'], 2),
  ('Southeast', 'southeast', ARRAY['FL', 'GA', 'NC', 'SC', 'TN', 'AL'], 3)
ON CONFLICT (slug) DO NOTHING;

-- Lost deal reasons
INSERT INTO lost_deal_reasons (label, display_order) VALUES
  ('Price', 1),
  ('Timing', 2),
  ('Went with competitor', 3),
  ('Scope changed', 4),
  ('Project cancelled', 5),
  ('No response', 6),
  ('Relationship', 7),
  ('Other', 8)
ON CONFLICT DO NOTHING;

-- Default office
INSERT INTO offices (name, slug, address) VALUES
  ('Dallas', 'dallas', 'Dallas, TX')
ON CONFLICT (slug) DO NOTHING;

-- Dev users (admin, director, rep)
INSERT INTO users (email, display_name, role, office_id)
SELECT 'admin@trock.dev', 'Admin User', 'admin', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (email, display_name, role, office_id)
SELECT 'director@trock.dev', 'James Director', 'director', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (email, display_name, role, office_id)
SELECT 'rep@trock.dev', 'Caleb Rep', 'rep', id FROM offices WHERE slug = 'dallas'
ON CONFLICT (email) DO NOTHING;
