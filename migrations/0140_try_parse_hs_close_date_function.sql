-- Global helper that parses a HubSpot close-won date text value to `date`,
-- yielding NULL (never throwing) for any value that is not a real calendar date.
--
-- WHY: the Won-period reporting path (§6.1) previously inlined a ~40-line nested
-- CASE calendar guard into every WHERE position (>= lower, <= upper, IS NOT NULL
-- eligibility) of getDealsForPipeline and friends. A single function-call token
-- cannot be mis-composed across interpolation sites the way a large multi-line
-- expression can, so the guard now lives here and the TypeScript helpers emit one
-- call: public.try_parse_hs_close_date(<raw>).
--
-- Lives in `public` (global / shared) so every office_* tenant schema can call it.
-- Callers qualify it explicitly as public.try_parse_hs_close_date(...) so the
-- tenant search_path is irrelevant.
--
-- SEMANTICS (must match the prior inline guard exactly so YTD totals are unchanged
-- = 175 deals / $7.82M):
--   1. NULL / '' / '0' -> NULL (the empty + HubSpot "0" unset sentinels).
--   2. Leading 10 chars must be YYYY-MM-DD, month 01-12, day 01-31 (dashes
--      required). [0-9] not \d. This mirrors the old regex so the admitted row set
--      is identical; slash/space/other formats that ::date would otherwise accept
--      stay rejected.
--   3. The ISO prefix is cast with ::date inside an exception trap: genuine
--      calendar dates pass; invalid ones (2026-02-31, 2026-02-29 in a non-leap
--      year, 0000-01-01) raise on the cast and are trapped to NULL. The trap
--      subsumes the old leap-year / month-length / year>=1 arithmetic.
-- IMMUTABLE is correct: output depends only on `raw`. The ::date cast of an ISO
-- YYYY-MM-DD string is DateStyle-independent, so it is deterministic.

CREATE OR REPLACE FUNCTION public.try_parse_hs_close_date(raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  d date;
BEGIN
  IF raw IS NULL OR raw = '' OR raw = '0' THEN
    RETURN NULL;
  END IF;
  IF substr(raw, 1, 10) !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    d := substr(raw, 1, 10)::date;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  RETURN d;
END;
$fn$;
