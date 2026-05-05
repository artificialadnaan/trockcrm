-- Configurable global notification recipient groups.
-- Due diligence recipients are public/global because users are public/global.

CREATE TABLE IF NOT EXISTS public.notification_recipient_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_recipient_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS notification_recipient_assignments_group_idx
  ON public.notification_recipient_assignments(group_id);

CREATE INDEX IF NOT EXISTS notification_recipient_assignments_user_idx
  ON public.notification_recipient_assignments(user_id);

INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES (
  'lead_due_diligence',
  'Lead Due Diligence',
  'Recipients who receive new-customer lead due diligence approval requests.'
)
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- Seed only when matching users already exist. Empty groups are allowed; lead
-- creation still creates pending DD rows and admins can configure recipients.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) IN ('tyamashita@trockgc.com', 'adnaan.iqbal@gmail.com')
WHERE g.key = 'lead_due_diligence'
ON CONFLICT (group_id, user_id) DO NOTHING;
