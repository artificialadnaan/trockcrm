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
COMMENT ON TABLE public.service_rfp_submissions IS
  'First service RFP outbox reservation and sales attribution; retries/reassignments never replace it. Historical basis means earliest retained submission with owner at capture, not proven historical attribution.';
