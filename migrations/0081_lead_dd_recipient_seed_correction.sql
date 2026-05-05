-- Backfill the lead_due_diligence recipient group with the correct
-- Takashi email. Migration 0079 used an outdated address that didn't
-- match any user records, leaving the group empty.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) IN ('tyamashita@trockgc.com', 'adnaan.iqbal@gmail.com')
WHERE g.key = 'lead_due_diligence'
ON CONFLICT (group_id, user_id) DO NOTHING;
