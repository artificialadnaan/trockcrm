-- Migration 0031: Intervention system actor
-- Ensures reopened intervention history writes have a valid public.users FK target.

INSERT INTO public.users (
  id,
  email,
  display_name,
  role,
  office_id,
  is_active,
  notification_prefs
)
SELECT
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'system+interventions@trock.local',
  'Intervention System',
  'admin'::user_role,
  office.id,
  false,
  '{}'::jsonb
FROM (
  SELECT id
  FROM public.offices
  ORDER BY created_at ASC, id ASC
  LIMIT 1
) AS office
ON CONFLICT (email) DO NOTHING;
