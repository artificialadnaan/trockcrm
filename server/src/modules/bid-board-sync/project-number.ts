/**
 * Project-number canonicalization for Bid Board <-> CRM deal matching.
 *
 * Visually-identical project numbers that differ only by Unicode dash glyph
 * (U+2010..U+2015 vs ASCII hyphen), non-breaking space (U+00A0), letter case, or
 * surrounding whitespace previously failed the exact-string match in findDealMatches.
 * This module folds those differences so the incoming value, the stored column, and the
 * unique index all canonicalize the same way.
 *
 * `canonicalizeProjectNumber` (TS, applied to the incoming value) and
 * `canonicalProjectNumberSql` (SQL, applied to the deal columns and the migration 0149
 * unique index) MUST stay in lockstep. Changing one without the other silently breaks
 * matching. A test asserts the migration SQL embeds `canonicalProjectNumberSql(...)`.
 */

// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
// U+2013 en dash, U+2014 em dash, U+2015 horizontal bar.
const UNICODE_DASHES = /[‐-―]/g;
const NON_BREAKING_SPACE = / /g;

// Surrounding ASCII whitespace: space, tab, LF, VT, FF, CR. Mirrored exactly by the
// SQL btrim character set below so the TS and SQL canonical forms agree.
const SURROUNDING_ASCII_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

export function canonicalizeProjectNumber(value: unknown): string | null {
  if (value == null) return null;
  const canonical = String(value)
    .normalize("NFC")
    .replace(UNICODE_DASHES, "-")
    .replace(NON_BREAKING_SPACE, "")
    .replace(SURROUNDING_ASCII_WHITESPACE, "")
    .toLowerCase();
  return canonical.length > 0 ? canonical : null;
}

// translate() "from" set: the six Unicode dashes (each mapped to '-') followed by NBSP,
// which has no counterpart in the "to" set and is therefore deleted. Emitted as \uXXXX
// escapes inside a Postgres E'' (escape) string literal.
const SQL_TRANSLATE_FROM = "\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u00a0";
const SQL_TRANSLATE_TO = "------"; // six hyphens; NBSP (7th "from" char) is dropped
// btrim character set = space, tab, LF, VT, FF, CR (chr(32/9/10/11/12/13)) — the same
// ASCII whitespace the TS regex strips. Built with chr() (all-ASCII, IMMUTABLE) rather
// than a control-char string literal; single-arg Postgres btrim strips only ASCII space.
const SQL_TRIM_CHARS_EXPR = "chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)";

/**
 * Postgres expression canonicalizing `columnExpr` identically to
 * canonicalizeProjectNumber(): NFC-normalize, fold Unicode dashes to '-', delete NBSP,
 * trim surrounding whitespace, lowercase. Requires PostgreSQL 13+ for normalize(text,
 * NFC) (the CRM runs PG 18). `columnExpr` is always a trusted internal column reference,
 * never user input.
 */
export function canonicalProjectNumberSql(columnExpr: string): string {
  return `lower(btrim(translate(normalize(${columnExpr}, NFC), E'${SQL_TRANSLATE_FROM}', '${SQL_TRANSLATE_TO}'), ${SQL_TRIM_CHARS_EXPR}))`;
}
