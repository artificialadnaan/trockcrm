-- Migration 0161: per-user CRM email signature.
--
-- `email_signature` holds a user's sanitized signature HTML (a logo is an <img> pointing at the
-- public signature-logo asset route). It is appended to user-composed outbound mail in
-- email.service.sendEmail (compose + reply/forward + dev mock) and is NEVER applied to system/Resend
-- mail (invites, notifications, RFP). NULL/empty = no signature appended.
--
-- users is a shared public table (not per-tenant), so this is a single public.* alter. Idempotent.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_signature text;
