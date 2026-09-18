-- Migration 0222: Weekly Reports — the client-facing weekly progress report that superintendents author
-- in T-Rock Cam, PMs review, and clients receive by email with a durable link and a PDF.
--
-- 0221 is the highest number on main, so this is the next free one. (0184/0186/0201 are each used twice
-- on disk; the runner tolerates that and nothing here depends on the numbering being dense.)
--
-- PER-OFFICE (office_* schemas) for everything except the public share token, mirroring 0172's field
-- scorecards: every row here is deal-scoped, `deal_id` is a real FK into `%I.deals` which only exists per
-- tenant, and every reader arrives through the request's search_path. The one exception is
-- `public.weekly_report_tokens` — the /wr/:token viewer must resolve a token to its office BEFORE it can
-- pick a search_path, which is the same reasoning that put `public.field_ai_report_runs` (0209) in public.
--
-- SIX TABLES, and the less obvious three are the ones worth explaining:
--
--   • `weekly_report_dismissals` exists because a MISSED week has no `weekly_reports` row — nobody ever
--     started one. The dashboard generates expected weeks from the cadence and left-joins reports; a week
--     matching neither a report nor a dismissal is "Not started" and keeps aging. There is nowhere else a
--     dismissal could live.
--
--   • `weekly_report_reminders_sent` exists because the reminder cron is not idempotent without it. The
--     worker restarts routinely (deploys, OOM, Railway shuffles) and a restart inside the 07:00 window
--     would re-send every reminder it had already sent that morning.
--
--   • `weekly_report_photos.caption` is a SEPARATE column from `files.description` on purpose, and this
--     is a stated product requirement rather than an implementation preference: editing a photo's caption
--     for a weekly report must NOT rewrite the description the field crew typed when they captured it.
--     Keeping the report caption on the link row makes that structural — there is no code path that could
--     accidentally write through, because the original column is not in this table.
--
-- SNAPSHOT-AT-SEND. `weekly_reports.snapshot` freezes the whole header block (client, client team, T-Rock
-- team, contract/start/completion dates and their notes) at the moment the report is sent. The live
-- `weekly_report_projects` row drives the NEXT report; a sent report reads its own snapshot. Without this,
-- swapping a PM in September silently rewrites the team block on every report already delivered in August
-- — including the PDF's on-page contact details, which the client has already read.
--
-- Idempotent / replayable. Skips any office missing `deals` or `files` rather than creating a partial
-- schema, exactly as 0172 does: `weekly_report_photos` FKs to `files` and every detail read joins it, so
-- a half-built office is worse than none.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL
       OR to_regclass(format('%I.files', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- The setup row. One per deal; every column editable from the CRM dashboard, because PMs and
    -- superintendents get swapped mid-project and the report must follow.
    --
    -- The three `*_note` columns exist because the reference report prints "TBD Permit" where a date
    -- belongs. A nullable date plus a note keeps date arithmetic (remaining weeks, cadence bounds) working
    -- while still rendering the words the PM wants on the page; degrading the column to text would lose it.
    --
    -- cadence_weekday uses 0=Sunday .. 6=Saturday, matching BOTH Postgres EXTRACT(DOW) and JS getDay(),
    -- so the worker's SQL and the client's date maths agree without a translation layer.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_projects (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         property_display_name text,
         client_name text,
         client_doc_name text,
         client_doc_email text,
         client_pm_name text,
         client_pm_email text,
         client_rm_name text,
         client_rm_email text,
         client_cm_name text,
         client_cm_email text,
         trock_pm_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
         trock_super_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
         contract_date date,
         contract_date_note text,
         project_start_date date,
         project_start_date_note text,
         project_completion_date date,
         project_completion_date_note text,
         projected_duration_weeks integer CHECK (projected_duration_weeks IS NULL OR projected_duration_weeks >= 0),
         cadence_weekday smallint NOT NULL CHECK (cadence_weekday BETWEEN 0 AND 6),
         cadence_start_date date NOT NULL,
         cadence_end_date date,
         status varchar(20) NOT NULL DEFAULT ''active''
           CHECK (status IN (''active'', ''paused'', ''completed'')),
         is_active boolean NOT NULL DEFAULT true,
         created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_projects_cadence_range CHECK (
           cadence_end_date IS NULL OR cadence_end_date >= cadence_start_date
         )
       )',
      schema_name, schema_name
    );
    -- Partial unique: a deal has at most one LIVE weekly-report setup. Soft-deleted rows (is_active=false)
    -- stay for history and must not block re-creating the setup later.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_projects_deal_uidx
         ON %I.weekly_report_projects (deal_id) WHERE is_active',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_projects_status_idx
         ON %I.weekly_report_projects (status, cadence_weekday) WHERE is_active',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_projects_super_idx
         ON %I.weekly_report_projects (trock_super_user_id) WHERE is_active',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_projects_pm_idx
         ON %I.weekly_report_projects (trock_pm_user_id) WHERE is_active',
      schema_name
    );

    -- One row per project per week per version.
    --
    -- client_submission_id is the phone''s idempotency key, same contract as field_scorecards: a retried
    -- submit over a flaky LTE connection must not create a second report for the same week.
    --
    -- status is a strict ladder — draft -> pending_review -> approved -> sent — enforced in the service
    -- layer. The CHECK here only bounds the domain; it cannot express legal transitions.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_reports (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         client_submission_id uuid NOT NULL,
         weekly_report_project_id uuid NOT NULL REFERENCES %I.weekly_report_projects(id) ON DELETE CASCADE,
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         week_of date NOT NULL,
         version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
         superseded_by_id uuid REFERENCES %I.weekly_reports(id) ON DELETE SET NULL,
         status varchar(20) NOT NULL DEFAULT ''draft''
           CHECK (status IN (''draft'', ''pending_review'', ''approved'', ''sent'')),
         work_completed text,
         next_week_look_ahead text,
         issues_concerns text,
         completion_percent numeric(5,2) CHECK (completion_percent IS NULL OR (completion_percent >= 0 AND completion_percent <= 100)),
         weather_delay_days integer CHECK (weather_delay_days IS NULL OR weather_delay_days >= 0),
         remaining_weeks integer,
         projected_duration_weeks integer,
         snapshot jsonb,
         authored_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         authored_at timestamptz,
         submitted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         submitted_at timestamptz,
         reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         reviewed_at timestamptz,
         sent_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         sent_at timestamptz,
         pdf_r2_key text,
         pdf_r2_bucket text,
         pdf_generated_at timestamptz,
         pdf_render_version integer NOT NULL DEFAULT 0,
         send_attempts integer NOT NULL DEFAULT 0,
         send_error text,
         is_active boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_reports_client_submission_id_key UNIQUE (client_submission_id)
       )',
      schema_name, schema_name, schema_name, schema_name
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_project_week_version_uidx
         ON %I.weekly_reports (weekly_report_project_id, week_of, version) WHERE is_active',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_project_week_idx
         ON %I.weekly_reports (weekly_report_project_id, week_of DESC)',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_deal_idx ON %I.weekly_reports (deal_id, week_of DESC)',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_reports_status_idx
         ON %I.weekly_reports (status, week_of DESC) WHERE is_active',
      schema_name
    );

    -- Report-specific photo captions. See the header: caption lives HERE, never on files.description.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_photos (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         weekly_report_id uuid NOT NULL REFERENCES %I.weekly_reports(id) ON DELETE CASCADE,
         file_id uuid NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
         caption text,
         sort_order integer NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_photos_report_file_key UNIQUE (weekly_report_id, file_id)
       )',
      schema_name, schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_photos_report_idx
         ON %I.weekly_report_photos (weekly_report_id, sort_order)',
      schema_name
    );

    -- A week that was never filed and has been consciously written off. Keyed by (project, week_of)
    -- because there is no report row to hang it on.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_dismissals (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         weekly_report_project_id uuid NOT NULL REFERENCES %I.weekly_report_projects(id) ON DELETE CASCADE,
         week_of date NOT NULL,
         reason text NOT NULL,
         dismissed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         dismissed_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_dismissals_project_week_key UNIQUE (weekly_report_project_id, week_of)
       )',
      schema_name, schema_name
    );

    -- Reminder idempotency. kind: t_minus_2 | t_minus_1 | due_digest.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_reminders_sent (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         weekly_report_project_id uuid NOT NULL REFERENCES %I.weekly_report_projects(id) ON DELETE CASCADE,
         week_of date NOT NULL,
         kind varchar(20) NOT NULL CHECK (kind IN (''t_minus_2'', ''t_minus_1'', ''due_digest'')),
         sent_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_reminders_sent_key UNIQUE (weekly_report_project_id, week_of, kind)
       )',
      schema_name, schema_name
    );

    -- Per-office settings. Single row, enforced by a partial unique index on a constant expression so the
    -- service can UPSERT without first SELECTing, and so a concurrent double-save cannot create a second row.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_settings (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         singleton boolean NOT NULL DEFAULT true CHECK (singleton),
         leadership_recipient_emails text[] NOT NULL DEFAULT ''{}'',
         updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_settings_singleton_key UNIQUE (singleton)
       )',
      schema_name
    );
  END LOOP;
END $tenant$;

-- Public share tokens. NOT per-office: /wr/:token has no office context until the token is resolved.
-- `token` stores a SHA-256 HASH — the raw token exists only in the URL we email, so a database read
-- cannot recover a live link. Identical scheme to public.public_photo_tokens (0084).
CREATE TABLE IF NOT EXISTS public.weekly_report_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  weekly_report_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  office_slug text NOT NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weekly_report_tokens_report_idx
  ON public.weekly_report_tokens (weekly_report_id);
CREATE INDEX IF NOT EXISTS weekly_report_tokens_tenant_idx
  ON public.weekly_report_tokens (tenant_id, weekly_report_id);

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  property_display_name text,
  client_name text,
  client_doc_name text,
  client_doc_email text,
  client_pm_name text,
  client_pm_email text,
  client_rm_name text,
  client_rm_email text,
  client_cm_name text,
  client_cm_email text,
  trock_pm_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  trock_super_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  contract_date date,
  contract_date_note text,
  project_start_date date,
  project_start_date_note text,
  project_completion_date date,
  project_completion_date_note text,
  projected_duration_weeks integer CHECK (projected_duration_weeks IS NULL OR projected_duration_weeks >= 0),
  cadence_weekday smallint NOT NULL CHECK (cadence_weekday BETWEEN 0 AND 6),
  cadence_start_date date NOT NULL,
  cadence_end_date date,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed')),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_projects_cadence_range CHECK (
    cadence_end_date IS NULL OR cadence_end_date >= cadence_start_date
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_projects_deal_uidx
  ON office_dallas.weekly_report_projects (deal_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS weekly_report_projects_status_idx
  ON office_dallas.weekly_report_projects (status, cadence_weekday) WHERE is_active;
CREATE INDEX IF NOT EXISTS weekly_report_projects_super_idx
  ON office_dallas.weekly_report_projects (trock_super_user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS weekly_report_projects_pm_idx
  ON office_dallas.weekly_report_projects (trock_pm_user_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS office_dallas.weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_submission_id uuid NOT NULL,
  weekly_report_project_id uuid NOT NULL REFERENCES office_dallas.weekly_report_projects(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  week_of date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  superseded_by_id uuid REFERENCES office_dallas.weekly_reports(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'approved', 'sent')),
  work_completed text,
  next_week_look_ahead text,
  issues_concerns text,
  completion_percent numeric(5,2) CHECK (completion_percent IS NULL OR (completion_percent >= 0 AND completion_percent <= 100)),
  weather_delay_days integer CHECK (weather_delay_days IS NULL OR weather_delay_days >= 0),
  remaining_weeks integer,
  projected_duration_weeks integer,
  snapshot jsonb,
  authored_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  authored_at timestamptz,
  submitted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  sent_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  pdf_r2_key text,
  pdf_r2_bucket text,
  pdf_generated_at timestamptz,
  pdf_render_version integer NOT NULL DEFAULT 0,
  send_attempts integer NOT NULL DEFAULT 0,
  send_error text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_reports_client_submission_id_key UNIQUE (client_submission_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_project_week_version_uidx
  ON office_dallas.weekly_reports (weekly_report_project_id, week_of, version) WHERE is_active;
CREATE INDEX IF NOT EXISTS weekly_reports_project_week_idx
  ON office_dallas.weekly_reports (weekly_report_project_id, week_of DESC);
CREATE INDEX IF NOT EXISTS weekly_reports_deal_idx
  ON office_dallas.weekly_reports (deal_id, week_of DESC);
CREATE INDEX IF NOT EXISTS weekly_reports_status_idx
  ON office_dallas.weekly_reports (status, week_of DESC) WHERE is_active;

CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_report_id uuid NOT NULL REFERENCES office_dallas.weekly_reports(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES office_dallas.files(id) ON DELETE CASCADE,
  caption text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_photos_report_file_key UNIQUE (weekly_report_id, file_id)
);
CREATE INDEX IF NOT EXISTS weekly_report_photos_report_idx
  ON office_dallas.weekly_report_photos (weekly_report_id, sort_order);

CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_report_project_id uuid NOT NULL REFERENCES office_dallas.weekly_report_projects(id) ON DELETE CASCADE,
  week_of date NOT NULL,
  reason text NOT NULL,
  dismissed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_dismissals_project_week_key UNIQUE (weekly_report_project_id, week_of)
);

CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_reminders_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_report_project_id uuid NOT NULL REFERENCES office_dallas.weekly_report_projects(id) ON DELETE CASCADE,
  week_of date NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('t_minus_2', 't_minus_1', 'due_digest')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_reminders_sent_key UNIQUE (weekly_report_project_id, week_of, kind)
);

CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true CHECK (singleton),
  leadership_recipient_emails text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_settings_singleton_key UNIQUE (singleton)
);
-- TENANT_SCHEMA_END
