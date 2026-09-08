-- One immutable contribution per office/deal. Public storage avoids changing every tenant's deals
-- shape; every read/write must bind the authenticated office AND the tenant deal row.
CREATE TABLE IF NOT EXISTS public.service_rfp_submissions (
  office_id uuid NOT NULL REFERENCES public.offices(id),
  deal_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL,
  assigned_rep_id uuid,
  assigned_rep_name text,
  source_event_id text NOT NULL,
  evidence_basis text NOT NULL CHECK (evidence_basis IN ('first_submission', 'historical')),
  PRIMARY KEY (office_id, deal_id)
);
CREATE INDEX IF NOT EXISTS service_rfp_submissions_office_date_idx
  ON public.service_rfp_submissions (office_id, submitted_at);
-- Supports both office-wide earliest-history grouping and a single deal's prior-evidence lookup,
-- including completed/dead rows and both enqueue paths. Keep predicate aligned with serviceRfpJobSql.
CREATE INDEX IF NOT EXISTS job_queue_service_rfp_history_idx
  ON public.job_queue (office_id, (payload->>'dealId'), created_at)
  WHERE job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
    AND (lower(COALESCE(payload->'body'->'deal'->>'projectType', '')) IN ('4', 'service')
      OR (COALESCE(payload->'body'->'deal'->>'projectType', '') = ''
        AND payload->'body'->'deal'->>'workflowRoute' = 'service'));
COMMENT ON TABLE public.service_rfp_submissions IS
  'First service RFP outbox reservation and sales attribution; retries/reassignments never replace it. Historical basis means earliest retained submission with owner at capture, not proven historical attribution.';
