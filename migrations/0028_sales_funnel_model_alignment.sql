ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS qualification_scope varchar(255),
  ADD COLUMN IF NOT EXISTS qualification_budget_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS qualification_company_fit boolean,
  ADD COLUMN IF NOT EXISTS qualification_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS director_review_decision varchar(20),
  ADD COLUMN IF NOT EXISTS director_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS director_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS director_review_reason text;
