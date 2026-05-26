-- Replace legacy deal regions with state-defined regions.
-- Texas and Southeast are retained but deactivated because existing deals may
-- still reference those rows until the explicit deal-region backfill is run.

INSERT INTO public.region_config (id, name, slug, states, display_order, is_active)
VALUES
  ('22222222-2222-4222-8222-222222222222', 'West Coast', 'west_coast', ARRAY['WA', 'OR', 'CA', 'NV', 'ID', 'MT', 'WY', 'UT', 'CO', 'AZ', 'NM', 'AK', 'HI'], 1, true),
  ('11111111-1111-4111-8111-111111111111', 'Central', 'central', ARRAY['ND', 'SD', 'NE', 'KS', 'OK', 'TX', 'MN', 'IA', 'MO', 'AR', 'LA'], 2, true),
  ('33333333-3333-4333-8333-333333333333', 'East Coast', 'east_coast', ARRAY['WI', 'IL', 'MI', 'IN', 'OH', 'KY', 'TN', 'MS', 'AL', 'GA', 'FL', 'WV', 'VA', 'NC', 'SC', 'PA', 'NY', 'ME', 'VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD'], 3, true)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    states = EXCLUDED.states,
    display_order = EXCLUDED.display_order,
    is_active = true;

UPDATE public.region_config
SET is_active = false
WHERE slug IN ('texas', 'southeast');
