CREATE TABLE IF NOT EXISTS office_dallas.cleanup_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type varchar NOT NULL,
  record_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  action varchar NOT NULL,
  field_changes jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleanup_audit_log_user_created
  ON office_dallas.cleanup_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cleanup_audit_log_record
  ON office_dallas.cleanup_audit_log (record_type, record_id, created_at DESC);
