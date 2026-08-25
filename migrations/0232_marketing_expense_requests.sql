-- Migration 0232: marketing & advertising expense requests.
--
-- Digitizes TRC_Marketing_Advertising_Expense_Request.docx: a rep fills in the form, one approver
-- (today: the `marketing_expense_approver` recipient group) approves or denies it, and three emails go out
-- through the job queue.
--
-- SHAPE. Per-office tenant tables, so an office_% DO-loop for existing tenants plus the marked block the
-- office provisioner clones for new ones (server/src/modules/office/service.ts replays the section between
-- the markers with office_dallas rewritten). Both halves are required and neither is optional: 0117 shipped
-- with only the loop and new offices have been missing its table ever since.
--
-- THE DRAFT STATE IS LOAD-BEARING. `attachments` need a request id and the approver must not be emailed
-- before they exist, so the row is born `draft`, the client uploads against it, and POST /:id/submit flips
-- it to `pending`. `marketing_expense_requests_submitted_check` is what makes that ordering a DB fact
-- rather than a convention: nothing but a draft may exist without a submitted_at.
--
-- TWO-STAGE READY, FOR REAL. `steps_required` on the parent is what makes "all steps approved" computable —
-- without it, "every approval row is approved" is trivially true at one step and adding a CEO/CFO row later
-- would finalize existing requests at step 1. Step N+1 is decidable only once step N is approved
-- (enforced in the service), and a denial or a withdrawal marks every later step `skipped`, so
-- `decision IS NULL` means exactly "still actionable" and the queue can filter on it.
--
-- MONEY. numeric(14,2) dollars-with-cents, NOT cents, and `total_requested` is computed in SQL inside the
-- INSERT/UPDATE — never in JS. There is no decimal library in this repo and floats do not add money.
--
-- REQUEST NUMBER. `MER-` + a zero-padded per-office counter allocated from
-- public.marketing_expense_request_sequences with the house insert-then-SELECT-FOR-UPDATE-then-UPDATE
-- pattern (server/src/services/projectNumber.ts, table 0068). There is no CREATE SEQUENCE anywhere in
-- migrations/ and this does not introduce the first one. Four digits caps at MER-9999 per office; the
-- allocator raises rather than wrapping. Numbers are allocated at CREATE, so an abandoned draft burns one —
-- accepted, because the number is the row's user-facing handle from the moment it exists and the
-- alternative makes it nullable on every read path.

-- ---------------------------------------------------------------------------
-- PUBLIC: per-office request-number counter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_expense_request_sequences (
  tenant_schema text PRIMARY KEY,
  last_number   integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- PUBLIC: exactly-once email ledger
-- ---------------------------------------------------------------------------
-- Same protocol as 0174 (rfp_pending_sla_email_receipts), and for the same reason:
--   1. BEFORE sending, the worker INSERTs a CLAIM row (ON CONFLICT DO NOTHING) carrying a frozen snapshot
--      of every field the email renders AND the recipient list as first seen. The claim is never deleted.
--   2. `sent_at` (NULLABLE, no default) marks completion and is stamped only AFTER a durable send. A crash
--      between claim and send, or a provider failure, leaves it NULL so the retry goes again.
-- Retries render from the STORED snapshot, so a rename or a recipient-list edit between attempts cannot
-- change the payload and the same Resend idempotency key stays valid.
--
-- step_order is in the KEY, not decoration. Without it a two-stage request sends ONE decision email in
-- total, because step 2's send would collide with step 1's receipt. Kinds that are not per-step
-- (submitted_approver, submitted_submitter) use 0.
CREATE TABLE IF NOT EXISTS public.marketing_expense_request_email_receipts (
  tenant_schema     text NOT NULL,
  request_id        uuid NOT NULL,
  email_kind        text NOT NULL,
  step_order        smallint NOT NULL DEFAULT 0,
  -- Frozen snapshot: everything the three bodies render.
  request_number    text,
  requested_by_name text,
  vendor_event      text,
  needed_by         date,
  total_requested   numeric(14,2),
  purpose           text,
  decision          text,
  decision_reason   text,
  recipient_emails  text,
  resend_message_id text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, request_id, email_kind, step_order),
  CONSTRAINT marketing_expense_email_receipts_kind_check
    CHECK (email_kind IN ('submitted_approver', 'submitted_submitter', 'decided_submitter'))
);

CREATE INDEX IF NOT EXISTS marketing_expense_email_receipts_request_idx
  ON public.marketing_expense_request_email_receipts (tenant_schema, request_id);

-- ---------------------------------------------------------------------------
-- PUBLIC: the approver recipient group
-- ---------------------------------------------------------------------------
-- Registered in shared/src/types/notification-recipient-groups.ts, which the server lazy-creates from and
-- the admin page draws a section for. Seeded here so the row exists before anyone opens that page.
INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES (
  'marketing_expense_approver',
  'Marketing Expense Approver',
  'Approves marketing and advertising expense requests.'
)
ON CONFLICT (key) DO NOTHING;

-- Best-effort initial assignment. Conditional on the user row existing (same shape as 0081), so it is a
-- silent no-op on any database where Takashi has no account. That silence is survivable HERE and only here:
-- POST /:id/submit resolves the group inside the transaction and refuses the submit with a 409 naming the
-- admin page when it comes back empty, so an unassigned group is a blocked submit, never a mail to nobody.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u ON lower(u.email) = 'tyamashita@trockgc.com'
WHERE g.key = 'marketing_expense_approver'
ON CONFLICT (group_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- EXISTING TENANTS
-- ---------------------------------------------------------------------------
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    -- Skip a partially-provisioned office schema that has no deals table yet: the REFERENCES clauses below
    -- and the files ALTER would otherwise raise and abort the whole migration — for every other tenant too.
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.marketing_expense_requests (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_number     TEXT NOT NULL,
          status             VARCHAR(20) NOT NULL DEFAULT 'draft',
          submitted_by       UUID NOT NULL REFERENCES public.users(id),
          submitted_at       TIMESTAMPTZ,
          requested_by_name  TEXT NOT NULL,
          department         TEXT,
          needed_by          DATE,
          vendor_event       TEXT NOT NULL,
          location_dates     TEXT,
          purpose            TEXT NOT NULL,
          expected_return    TEXT NOT NULL,
          cost_advertising   NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_registration  NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_travel        NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_lodging       NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_meals         NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_materials     NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_other_1       NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_other_1_label TEXT,
          cost_other_2       NUMERIC(14,2) NOT NULL DEFAULT 0,
          cost_other_2_label TEXT,
          total_requested    NUMERIC(14,2) NOT NULL,
          budget_job_code    TEXT,
          travel_required    BOOLEAN NOT NULL DEFAULT FALSE,
          attendees          TEXT,
          business_meetings  TEXT,
          payment_method     VARCHAR(20),
          attachment_kinds   TEXT[] NOT NULL DEFAULT '{}',
          steps_required     SMALLINT NOT NULL DEFAULT 1,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT marketing_expense_requests_number_uq UNIQUE (request_number),
          CONSTRAINT marketing_expense_requests_status_check
            CHECK (status IN ('draft', 'pending', 'approved', 'denied', 'withdrawn')),
          CONSTRAINT marketing_expense_requests_submitted_check
            CHECK (status = 'draft' OR submitted_at IS NOT NULL),
          CONSTRAINT marketing_expense_requests_payment_method_check
            CHECK (payment_method IS NULL
                   OR payment_method IN ('invoice_ap', 'company_card', 'reimbursement')),
          CONSTRAINT marketing_expense_requests_attachment_kinds_check
            CHECK (attachment_kinds <@ ARRAY['quote_proposal', 'event_details', 'travel_estimate', 'other']::text[]),
          CONSTRAINT marketing_expense_requests_steps_required_check CHECK (steps_required >= 1),
          CONSTRAINT marketing_expense_requests_costs_check
            CHECK (cost_advertising >= 0 AND cost_registration >= 0 AND cost_travel >= 0
                   AND cost_lodging >= 0 AND cost_meals >= 0 AND cost_materials >= 0
                   AND cost_other_1 >= 0 AND cost_other_2 >= 0),
          CONSTRAINT marketing_expense_requests_total_check CHECK (total_requested >= 0),
          -- A DRAFT may be incomplete; anything the approver can see may not be $0.00. The
          -- service refuses that submit with a 400 naming the problem — this is the backstop
          -- for a caller that never goes through it.
          CONSTRAINT marketing_expense_requests_nonzero_check
            CHECK (status = 'draft' OR total_requested > 0)
        );

        CREATE INDEX IF NOT EXISTS marketing_expense_requests_submitter_idx
          ON %1$I.marketing_expense_requests (submitted_by, created_at DESC);
        CREATE INDEX IF NOT EXISTS marketing_expense_requests_status_idx
          ON %1$I.marketing_expense_requests (status, created_at DESC);

        CREATE TABLE IF NOT EXISTS %1$I.marketing_expense_request_approvals (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_id         UUID NOT NULL
                               REFERENCES %1$I.marketing_expense_requests(id) ON DELETE CASCADE,
          step_order         SMALLINT NOT NULL,
          approver_group_key TEXT NOT NULL,
          decision           VARCHAR(20),
          decided_by         UUID REFERENCES public.users(id),
          decided_at         TIMESTAMPTZ,
          reason             TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT marketing_expense_approvals_request_step_uq UNIQUE (request_id, step_order),
          CONSTRAINT marketing_expense_approvals_step_order_check CHECK (step_order >= 1),
          CONSTRAINT marketing_expense_approvals_decision_check
            CHECK (decision IS NULL OR decision IN ('approved', 'denied', 'skipped'))
        );

        CREATE INDEX IF NOT EXISTS marketing_expense_approvals_open_idx
          ON %1$I.marketing_expense_request_approvals (step_order, request_id)
          WHERE decision IS NULL;
      $sql$,
      schema_name
    );

    -- files linkage. The expense request owns its attachments directly through a nullable FK column,
    -- exactly as 0058 did for leads.
    --
    -- Do not rebuild the historical files_association_check here. Field-photo capture intentionally
    -- persists a targetless file before a user chooses where to file it; files/service.ts admits that
    -- narrow flow with allowUnassigned, and field/photos-service later lists those pending rows. A table
    -- CHECK requiring an association would contradict that supported state (including when added NOT
    -- VALID, which still rejects every future targetless write). Ordinary file uploads remain guarded by
    -- files/service.ts:validateAssociations. Migration 0241 removes any inherited historical CHECK one
    -- office at a time; keeping that ACCESS EXCLUSIVE DDL out of this all-office DO loop avoids holding
    -- one office's files lock while later offices are migrated.
    IF to_regclass(format('%I.files', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %1$I.files ADD COLUMN IF NOT EXISTS marketing_expense_request_id UUID',
        schema_name
      );

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'files_marketing_expense_request_id_fkey'
          AND conrelid = format('%I.files', schema_name)::regclass
      ) THEN
        -- CASCADE, not SET NULL: deleting a request must delete its private attachment rather than
        -- silently reclassifying it as an unscoped file.
        EXECUTE format(
          'ALTER TABLE %1$I.files
             ADD CONSTRAINT files_marketing_expense_request_id_fkey
             FOREIGN KEY (marketing_expense_request_id)
             REFERENCES %1$I.marketing_expense_requests(id) ON DELETE CASCADE',
          schema_name
        );
      END IF;

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS files_marketing_expense_request_idx
           ON %1$I.files (marketing_expense_request_id, created_at)
           WHERE marketing_expense_request_id IS NOT NULL',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones the block below (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.marketing_expense_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number     TEXT NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'draft',
  submitted_by       UUID NOT NULL REFERENCES public.users(id),
  submitted_at       TIMESTAMPTZ,
  requested_by_name  TEXT NOT NULL,
  department         TEXT,
  needed_by          DATE,
  vendor_event       TEXT NOT NULL,
  location_dates     TEXT,
  purpose            TEXT NOT NULL,
  expected_return    TEXT NOT NULL,
  cost_advertising   NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_registration  NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_travel        NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_lodging       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_meals         NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_materials     NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_other_1       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_other_1_label TEXT,
  cost_other_2       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_other_2_label TEXT,
  total_requested    NUMERIC(14,2) NOT NULL,
  budget_job_code    TEXT,
  travel_required    BOOLEAN NOT NULL DEFAULT FALSE,
  attendees          TEXT,
  business_meetings  TEXT,
  payment_method     VARCHAR(20),
  attachment_kinds   TEXT[] NOT NULL DEFAULT '{}',
  steps_required     SMALLINT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketing_expense_requests_number_uq UNIQUE (request_number),
  CONSTRAINT marketing_expense_requests_status_check
    CHECK (status IN ('draft', 'pending', 'approved', 'denied', 'withdrawn')),
  CONSTRAINT marketing_expense_requests_submitted_check
    CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  CONSTRAINT marketing_expense_requests_payment_method_check
    CHECK (payment_method IS NULL
           OR payment_method IN ('invoice_ap', 'company_card', 'reimbursement')),
  CONSTRAINT marketing_expense_requests_attachment_kinds_check
    CHECK (attachment_kinds <@ ARRAY['quote_proposal', 'event_details', 'travel_estimate', 'other']::text[]),
  CONSTRAINT marketing_expense_requests_steps_required_check CHECK (steps_required >= 1),
  CONSTRAINT marketing_expense_requests_costs_check
    CHECK (cost_advertising >= 0 AND cost_registration >= 0 AND cost_travel >= 0
           AND cost_lodging >= 0 AND cost_meals >= 0 AND cost_materials >= 0
           AND cost_other_1 >= 0 AND cost_other_2 >= 0),
  CONSTRAINT marketing_expense_requests_total_check CHECK (total_requested >= 0),
  -- A DRAFT may be incomplete; anything the approver can see may not be $0.00.
  CONSTRAINT marketing_expense_requests_nonzero_check
    CHECK (status = 'draft' OR total_requested > 0)
);

CREATE INDEX IF NOT EXISTS marketing_expense_requests_submitter_idx
  ON office_dallas.marketing_expense_requests (submitted_by, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_expense_requests_status_idx
  ON office_dallas.marketing_expense_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS office_dallas.marketing_expense_request_approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         UUID NOT NULL
                       REFERENCES office_dallas.marketing_expense_requests(id) ON DELETE CASCADE,
  step_order         SMALLINT NOT NULL,
  approver_group_key TEXT NOT NULL,
  decision           VARCHAR(20),
  decided_by         UUID REFERENCES public.users(id),
  decided_at         TIMESTAMPTZ,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketing_expense_approvals_request_step_uq UNIQUE (request_id, step_order),
  CONSTRAINT marketing_expense_approvals_step_order_check CHECK (step_order >= 1),
  CONSTRAINT marketing_expense_approvals_decision_check
    CHECK (decision IS NULL OR decision IN ('approved', 'denied', 'skipped'))
);

CREATE INDEX IF NOT EXISTS marketing_expense_approvals_open_idx
  ON office_dallas.marketing_expense_request_approvals (step_order, request_id)
  WHERE decision IS NULL;

ALTER TABLE office_dallas.files ADD COLUMN IF NOT EXISTS marketing_expense_request_id UUID;

DO $files$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'files_marketing_expense_request_id_fkey'
      AND conrelid = 'office_dallas.files'::regclass
  ) THEN
    ALTER TABLE office_dallas.files
      ADD CONSTRAINT files_marketing_expense_request_id_fkey
      FOREIGN KEY (marketing_expense_request_id)
      REFERENCES office_dallas.marketing_expense_requests(id) ON DELETE CASCADE;
  END IF;

END $files$;

CREATE INDEX IF NOT EXISTS files_marketing_expense_request_idx
  ON office_dallas.files (marketing_expense_request_id, created_at)
  WHERE marketing_expense_request_id IS NOT NULL;
-- TENANT_SCHEMA_END
