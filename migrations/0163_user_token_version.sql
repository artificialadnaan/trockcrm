-- Monotonic session-invalidation token version. Each minted JWT carries the value current at mint;
-- a token whose version is behind users.token_version is rejected in middleware. Incremented on
-- deactivate, reactivate, and role change. Exact (no time granularity), so it can't accept a stale
-- token issued in the same second as an invalidation nor reject a freshly-minted one. DEFAULT 0 so
-- existing pre-feature tokens (no version claim, treated as 0) stay valid until that user is acted on.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
