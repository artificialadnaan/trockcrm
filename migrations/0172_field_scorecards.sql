-- 0172_field_scorecards.sql
-- Weekly Field Scorecard (mobile). Per-office structured scorecards, one row per scored section,
-- and photo-evidence links to gallery files. FKs + ON DELETE CASCADE live here (Drizzle keeps bare
-- uuid columns, matching the closeout-checklist / files convention).
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.field_scorecards (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         client_submission_id uuid NOT NULL,
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         week_of date NOT NULL,
         project_number text,
         superintendent_name text,
         pm_name text,
         total_score integer NOT NULL,
         rating varchar(40) NOT NULL,
         critical_deficiencies text[] NOT NULL DEFAULT ''{}'',
         action_items text[] NOT NULL DEFAULT ''{}'',
         status varchar(20) NOT NULL DEFAULT ''submitted'',
         submitted_by uuid NOT NULL,
         submitted_by_name text,
         submitted_at timestamptz NOT NULL DEFAULT now(),
         pdf_r2_key text,
         pdf_r2_bucket text,
         pdf_generated_at timestamptz,
         email_sent_at timestamptz,
         is_active boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT field_scorecards_client_submission_id_key UNIQUE (client_submission_id)
       )',
      schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS field_scorecards_deal_idx ON %I.field_scorecards (deal_id, submitted_at)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS field_scorecards_submitted_at_idx ON %I.field_scorecards (submitted_at)', schema_name);

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.field_scorecard_items (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         section_key varchar(40) NOT NULL,
         points integer NOT NULL,
         note text,
         CONSTRAINT field_scorecard_items_card_section_key UNIQUE (scorecard_id, section_key)
       )',
      schema_name, schema_name
    );

    -- Photo-evidence links depend on files; guard separately so an office missing files (drift) still
    -- gets the scorecard tables.
    IF to_regclass(format('%I.files', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.field_scorecard_photos (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
           section_key varchar(40) NOT NULL,
           file_id uuid NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
           created_at timestamptz NOT NULL DEFAULT now(),
           CONSTRAINT field_scorecard_photos_card_file_key UNIQUE (scorecard_id, file_id)
         )',
        schema_name, schema_name, schema_name
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS field_scorecard_photos_card_idx ON %I.field_scorecard_photos (scorecard_id)', schema_name);
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.field_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_submission_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  week_of date NOT NULL,
  project_number text,
  superintendent_name text,
  pm_name text,
  total_score integer NOT NULL,
  rating varchar(40) NOT NULL,
  critical_deficiencies text[] NOT NULL DEFAULT '{}',
  action_items text[] NOT NULL DEFAULT '{}',
  status varchar(20) NOT NULL DEFAULT 'submitted',
  submitted_by uuid NOT NULL,
  submitted_by_name text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  pdf_r2_key text,
  pdf_r2_bucket text,
  pdf_generated_at timestamptz,
  email_sent_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_scorecards_client_submission_id_key UNIQUE (client_submission_id)
);
CREATE INDEX IF NOT EXISTS field_scorecards_deal_idx ON office_dallas.field_scorecards (deal_id, submitted_at);
CREATE INDEX IF NOT EXISTS field_scorecards_submitted_at_idx ON office_dallas.field_scorecards (submitted_at);

CREATE TABLE IF NOT EXISTS office_dallas.field_scorecard_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  section_key varchar(40) NOT NULL,
  points integer NOT NULL,
  note text,
  CONSTRAINT field_scorecard_items_card_section_key UNIQUE (scorecard_id, section_key)
);

CREATE TABLE IF NOT EXISTS office_dallas.field_scorecard_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  section_key varchar(40) NOT NULL,
  file_id uuid NOT NULL REFERENCES office_dallas.files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_scorecard_photos_card_file_key UNIQUE (scorecard_id, file_id)
);
CREATE INDEX IF NOT EXISTS field_scorecard_photos_card_idx ON office_dallas.field_scorecard_photos (scorecard_id);
-- TENANT_SCHEMA_END
