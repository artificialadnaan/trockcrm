-- Re-seed the lead_due_diligence notification recipient group row.
--
-- Migration 0079 created the group and inserted this row; in production the
-- table is empty even though 0079 is recorded as applied. This idempotent
-- re-seed restores the row so the notification recipients admin page loads
-- and the DD email dispatch path can resolve a group id.
--
-- Application code (due-diligence-service.ts) also lazy-upserts this group on
-- read after this PR — this migration just shortens the recovery window.

INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES (
  'lead_due_diligence',
  'Lead Due Diligence',
  'Recipients who receive new-customer lead due diligence approval requests.'
)
ON CONFLICT (key) DO NOTHING;

-- Idempotent assignment re-seed: tyamashita + adnaan.iqbal, if those user
-- rows exist. Matches the 0079 / 0081 seed shape.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) IN ('tyamashita@trockgc.com', 'adnaan.iqbal@gmail.com')
WHERE g.key = 'lead_due_diligence'
ON CONFLICT (group_id, user_id) DO NOTHING;
