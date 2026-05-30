-- Migration 0142: roster-hygiene flag on public.users.
--
-- Adds public.users.is_test_data (boolean) so the director dashboard rosters can exclude
-- smoke-test accounts and a duplicate human row. public.users is a single SHARED (non-
-- tenant) table, so this is a plain ALTER -- there is no per-tenant office_* loop and no
-- provisioner replay block (contrast 0141, which adds a column to the per-tenant deals
-- table on every office_* schema).
--
-- SAFETY: purely additive + a backfill that sets is_test_data = true on EXPLICITLY NAMED
-- accounts only (no live name pattern / no ILIKE wildcard). It changes WHO appears in the
-- dashboard rep roster / Activity Pulse, NOT any deal or Won aggregate: getWonCloseSummary
-- and the canonical per-rep Won decomposition filter test DEALS (deals.is_test_data), which
-- is independent of this user flag. The smoke-test accounts own only test deals (already
-- excluded from Won), so the live Won total is UNCHANGED (office_dallas Won YTD stays
-- 191 / $9,778,045.90). Idempotent via IF NOT EXISTS + name-targeted, re-runnable UPDATEs.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_test_data boolean NOT NULL DEFAULT false;

-- Backfill: explicit per-account by exact display_name (NOT a live pattern). Known
-- smoke/test accounts surfaced by the director-dashboard audit.
UPDATE public.users
SET is_test_data = true
WHERE display_name IN (
  'Smoke Test Sales',
  'Smoke Test Admin',
  'SMOKE TEST DELETE Force Reenable Postdeploy'
);

-- Duplicate human row: keep the CANONICAL 'Adnaan Iqbal' (proper-cased, role-bearing,
-- deal-owning -- ~$924K pipeline) and flag ONLY the lowercase duplicate. Postgres '=' on
-- text is case-sensitive, so this matches 'adnaan iqbal' but never 'Adnaan Iqbal'.
UPDATE public.users
SET is_test_data = true
WHERE display_name = 'adnaan iqbal';
