-- Migration 0084: public photo tokens and Procore photo metadata.
-- Idempotent and safe to rerun.

CREATE TABLE IF NOT EXISTS public.public_photo_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  deal_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.offices(id),
  created_by_user_id uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS public_photo_tokens_deal_idx
  ON public.public_photo_tokens (deal_id);

CREATE INDEX IF NOT EXISTS public_photo_tokens_tenant_deal_idx
  ON public.public_photo_tokens (tenant_id, deal_id);

CREATE INDEX IF NOT EXISTS public_photo_tokens_token_idx
  ON public.public_photo_tokens (token);

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
  LOOP
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS procore_image_category_id bigint', tenant_schema);
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS procore_photo_link_id bigint', tenant_schema);
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS procore_photo_link_status varchar(50)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS deals_procore_photo_link_status_idx ON %I.deals(procore_photo_link_status)', tenant_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS deals_procore_image_category_idx ON %I.deals(procore_image_category_id)', tenant_schema);
  END LOOP;
END $$;
