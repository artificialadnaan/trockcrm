-- Migration 0016: Workflow Gap Implementation
-- Adds tables for deal team members, estimate line items, punch lists,
-- proposal tracking, workflow timers, and close-out checklists.
-- Derived from Service Workflow PDF and Estimating Workflow PDF gap analysis.

-- ============================================================================
-- 1. New enum types (public schema)
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE deal_team_role AS ENUM ('superintendent', 'estimator', 'project_manager', 'foreman', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE punch_list_type AS ENUM ('internal', 'external');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE punch_list_status AS ENUM ('open', 'in_progress', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE proposal_status AS ENUM (
    'not_started', 'drafting', 'sent', 'under_review',
    'revision_requested', 'accepted', 'signed', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE workflow_timer_type AS ENUM (
    'proposal_response', 'estimate_review', 'companycam_service',
    'final_billing', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE workflow_timer_status AS ENUM ('active', 'completed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. Per-tenant tables (iterate over office schemas)
-- ============================================================================

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP

    -- 2a. Deal Team Members
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_team_members (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         user_id UUID NOT NULL REFERENCES public.users(id),
         role deal_team_role NOT NULL,
         assigned_by UUID REFERENCES public.users(id),
         notes TEXT,
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deal_team_members_deal_user_role_uidx
         ON %I.deal_team_members (deal_id, user_id, role)
         WHERE is_active = TRUE',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_team_members_deal_id_idx
         ON %I.deal_team_members (deal_id)
         WHERE is_active = TRUE',
      schema_name
    );

    -- 2b. Estimate Sections
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_sections (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         name VARCHAR(255) NOT NULL,
         display_order INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_sections_deal_id_idx
         ON %I.estimate_sections (deal_id, display_order)',
      schema_name
    );

    -- 2c. Estimate Line Items
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_line_items (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         section_id UUID NOT NULL REFERENCES %I.estimate_sections(id),
         description VARCHAR(500) NOT NULL,
         quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
         unit VARCHAR(50),
         unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
         total_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
         notes TEXT,
         display_order INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name, schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_line_items_section_id_idx
         ON %I.estimate_line_items (section_id, display_order)',
      schema_name
    );

    -- 2d. Punch List Items
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.punch_list_items (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         type punch_list_type NOT NULL,
         title VARCHAR(500) NOT NULL,
         description TEXT,
         status punch_list_status NOT NULL DEFAULT ''open'',
         assigned_to UUID REFERENCES public.users(id),
         location VARCHAR(255),
         priority task_priority NOT NULL DEFAULT ''normal'',
         photo_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
         completed_at TIMESTAMPTZ,
         completed_by UUID REFERENCES public.users(id),
         created_by UUID NOT NULL REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS punch_list_items_deal_id_idx
         ON %I.punch_list_items (deal_id, type, status)',
      schema_name
    );

    -- 2e. Workflow Timers
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.workflow_timers (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         timer_type workflow_timer_type NOT NULL,
         label VARCHAR(255),
         started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         deadline_at TIMESTAMPTZ NOT NULL,
         completed_at TIMESTAMPTZ,
         status workflow_timer_status NOT NULL DEFAULT ''active'',
         created_by UUID REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS workflow_timers_deal_active_idx
         ON %I.workflow_timers (deal_id)
         WHERE status = ''active''',
      schema_name
    );

    -- 2f. Close-Out Checklist Items
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.closeout_checklist_items (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         step_key VARCHAR(100) NOT NULL,
         label VARCHAR(255) NOT NULL,
         is_completed BOOLEAN NOT NULL DEFAULT FALSE,
         completed_at TIMESTAMPTZ,
         completed_by UUID REFERENCES public.users(id),
         notes TEXT,
         display_order INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS closeout_checklist_deal_step_uidx
         ON %I.closeout_checklist_items (deal_id, step_key)',
      schema_name
    );

    -- 2g. Add proposal tracking columns to deals
    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS proposal_status proposal_status DEFAULT ''not_started'',
         ADD COLUMN IF NOT EXISTS proposal_sent_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS proposal_accepted_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS proposal_revision_count INTEGER DEFAULT 0,
         ADD COLUMN IF NOT EXISTS proposal_notes TEXT',
      schema_name
    );

  END LOOP;
END $$;
