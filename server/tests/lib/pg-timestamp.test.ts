import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresCalendarDate, isPostgresTzOffset, isPostgresYear } from "../../src/lib/pg-timestamp.js";

/**
 * This module exists to be the ONE owner of "will Postgres accept this timestamp literal?", because two
 * hand-rolled validators previously answered it differently and each carried a hole the other did not.
 * That justification only holds if the helpers are correct in ISOLATION — a future caller with a looser
 * regex must not be able to inherit a wrong answer from them.
 *
 * So these tests exercise the helpers directly rather than through a caller, and the offset sweep varies
 * the minute field across 00-99 rather than sampling plausible values. An earlier sweep of this space
 * generated minutes only from {00, 30, 59} — all valid — and therefore could not have found the
 * total-only bug that let `+14:99` (939 minutes, inside the 959 cap, but not a real time) through.
 */
describe("isPostgresYear", () => {
  it("rejects year zero and accepts its neighbour", () => {
    // The proleptic Gregorian calendar has no year 0; JavaScript's Date does.
    expect(isPostgresYear("0000")).toBe(false);
    expect(isPostgresYear("0001")).toBe(true);
    expect(isPostgresYear("2026")).toBe(true);
    expect(isPostgresYear("9999")).toBe(true);
  });

  it("rejects anything that is not a 4-digit year", () => {
    for (const bad of ["", "26", "20263", "abcd", "-001"]) expect(isPostgresYear(bad)).toBe(false);
  });
});

describe("isPostgresCalendarDate", () => {
  it("rejects calendar overflow that Date.parse silently rolls over", () => {
    expect(isPostgresCalendarDate("2026", "02", "30")).toBe(false);
    expect(isPostgresCalendarDate("2026", "04", "31")).toBe(false);
    expect(isPostgresCalendarDate("2026", "13", "01")).toBe(false);
  });

  it("accepts real dates including a genuine leap day", () => {
    expect(isPostgresCalendarDate("2026", "07", "27")).toBe(true);
    expect(isPostgresCalendarDate("2028", "02", "29")).toBe(true);
    expect(isPostgresCalendarDate("2026", "02", "28")).toBe(true);
  });
});

describe("isPostgresTzOffset", () => {
  it("accepts the absent and Z forms", () => {
    for (const ok of [undefined, null, "", "Z", "z"]) expect(isPostgresTzOffset(ok)).toBe(true);
  });

  it("accepts the bare-hour form Postgres emits", () => {
    // `+00` is what a timestamptz renders as; an earlier attempt at tightening this required two
    // minute digits and broke every legitimately issued cursor.
    expect(isPostgresTzOffset("+00")).toBe(true);
    expect(isPostgresTzOffset("-05")).toBe(true);
    expect(isPostgresTzOffset("+1430")).toBe(true);
    expect(isPostgresTzOffset("+14:30")).toBe(true);
  });

  it("holds the ±15:59 boundary exactly", () => {
    expect(isPostgresTzOffset("+15:59")).toBe(true);
    expect(isPostgresTzOffset("-15:59")).toBe(true);
    expect(isPostgresTzOffset("+16:00")).toBe(false);
    expect(isPostgresTzOffset("-16:00")).toBe(false);
  });

  it("bounds the MINUTE field independently of the total", () => {
    // 14*60 + 99 = 939, inside the 959-minute cap — a total-only check calls this valid, and Postgres
    // does not, because a minute field above 59 is not a time.
    expect(isPostgresTzOffset("+14:99")).toBe(false);
    expect(isPostgresTzOffset("+00:60")).toBe(false);
    expect(isPostgresTzOffset("-1499")).toBe(false);
    // ...while the largest legal minute at the same hour still passes.
    expect(isPostgresTzOffset("+14:59")).toBe(true);
  });
});

/**
 * The helpers checked against the authority itself, in ONE statement.
 *
 * Method matters here and I got it wrong first: probing each candidate with its own `pg.query` inside a
 * try/catch reports hundreds of false disagreements, because the first failed cast aborts the
 * transaction and every subsequent query fails for that reason instead of its own. A `plpgsql` wrapper
 * that traps the exception per row gives the true answer AND turns a 70-second test into ~100ms.
 *
 * The offset sweep varies the minute field across 00-99 rather than sampling plausible values. An
 * earlier sweep of this space generated minutes only from {00, 30, 59} — all valid — and so could not
 * have found the total-only bug that accepted `+14:99` (939 minutes, inside the 959 cap, but not a real
 * time).
 */
describe("the helpers agree with Postgres", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`SET TimeZone='UTC';`);
    // Per-row exception trapping: without it the first bad cast poisons the rest of the statement.
    await pg.exec(`CREATE FUNCTION casts_ok(t text) RETURNS boolean AS $$
      BEGIN PERFORM t::timestamptz; RETURN true;
      EXCEPTION WHEN others THEN RETURN false; END; $$ LANGUAGE plpgsql;`);
  }, 30000);

  afterAll(async () => {
    await pg?.close?.();
  });

  async function postgresVerdicts(literals: string[]): Promise<boolean[]> {
    const values = literals.map((literal, index) => `('${literal}',${index})`).join(",");
    const result: any = await pg.query(
      `SELECT i, casts_ok(v) AS good FROM (VALUES ${values}) s(v,i) ORDER BY i`,
    );
    return result.rows.map((row: any) => row.good as boolean);
  }

  it("matches Postgres across the whole timezone-offset space (both signs, hours 00-23, minutes 00-99)", async () => {
    const offsets: string[] = [];
    for (const sign of ["+", "-"]) {
      for (let hour = 0; hour <= 23; hour++) {
        for (let minute = 0; minute <= 99; minute++) {
          const hh = String(hour).padStart(2, "0");
          const mm = String(minute).padStart(2, "0");
          offsets.push(`${sign}${hh}:${mm}`, `${sign}${hh}${mm}`);
        }
      }
    }

    const verdicts = await postgresVerdicts(offsets.map((offset) => `2026-07-27 12:00:00${offset}`));
    const disagreements = offsets
      .map((offset, index) => ({ offset, helper: isPostgresTzOffset(offset), postgres: verdicts[index] }))
      .filter((row) => row.helper !== row.postgres)
      .map((row) => `${row.offset}: helper=${row.helper} postgres=${row.postgres}`);

    // Disagreement in EITHER direction is a bug: accepting what Postgres rejects is a 500, rejecting
    // what it accepts silently drops a legitimate filter.
    expect(disagreements).toEqual([]);
    expect(offsets.length).toBe(9600);
  }, 60000);

  it("matches Postgres across every 4-digit year, in both the date-only and datetime forms", async () => {
    const years = Array.from({ length: 10000 }, (_, y) => String(y).padStart(4, "0"));
    const literals = years.flatMap((year) => [`${year}-01-01`, `${year}-01-01 00:00:00+00`]);

    const verdicts = await postgresVerdicts(literals);
    const disagreements = literals
      .map((literal, index) => ({
        literal,
        helper: isPostgresCalendarDate(literal.slice(0, 4), "01", "01"),
        postgres: verdicts[index],
      }))
      .filter((row) => row.helper !== row.postgres)
      .map((row) => `${row.literal}: helper=${row.helper} postgres=${row.postgres}`);

    expect(disagreements).toEqual([]);
    // Exactly two rejections, both year 0000 — one per form. This is the number that justifies the
    // year guard, measured rather than assumed.
    expect(verdicts.filter((ok) => !ok).length).toBe(2);
  }, 60000);
});
