import { afterEach, describe, expect, it } from "vitest";

import {
  BID_BOARD_ESTIMATOR_USER_MAP_ENV,
  buildEstimatorDirectory,
  estimatorRosterUserIds,
  existingEstimatorUserId,
  isEstimatorResolutionConfigured,
  resolveEstimatorUserId,
} from "../../../src/modules/bid-board-sync/estimator-map.js";

const ALEX = "636fd7e9-2575-4826-b11d-2869b24a12cf";
const SIDNEY = "829fad98-af4c-4acf-ad53-6625e9c0bd32";
const KASON = "4d0a9d11-bb6c-4e51-896e-d3e62dee3a1d";

afterEach(() => {
  delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
});

describe("resolveEstimatorUserId", () => {
  it("resolves a mapped estimator name to the user id", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({
      "Alex Koch": ALEX,
      "Sidney Gibson": SIDNEY,
    });
    expect(resolveEstimatorUserId("Alex Koch")).toBe(ALEX);
    expect(resolveEstimatorUserId("Sidney Gibson")).toBe(SIDNEY);
  });

  it("normalizes case and surrounding/internal whitespace on the lookup key", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(resolveEstimatorUserId("  alex   koch ")).toBe(ALEX);
    expect(resolveEstimatorUserId("ALEX KOCH")).toBe(ALEX);
  });

  it("returns null for unmapped / blank / sentinel estimator values", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(resolveEstimatorUserId("Colby Burling")).toBeNull();
    expect(resolveEstimatorUserId("Not Assigned")).toBeNull();
    expect(resolveEstimatorUserId("")).toBeNull();
    expect(resolveEstimatorUserId("   ")).toBeNull();
    expect(resolveEstimatorUserId(null)).toBeNull();
    expect(resolveEstimatorUserId(undefined)).toBeNull();
  });

  it("is inert (all null) when the env var is unset", () => {
    expect(resolveEstimatorUserId("Alex Koch")).toBeNull();
  });

  it("re-parses when the env value changes (no stale cache across config updates)", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(resolveEstimatorUserId("Alex Koch")).toBe(ALEX);
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Sidney Gibson": SIDNEY });
    expect(resolveEstimatorUserId("Alex Koch")).toBeNull();
    expect(resolveEstimatorUserId("Sidney Gibson")).toBe(SIDNEY);
  });

  it("ignores malformed map entries without throwing (non-uuid values dropped)", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": "not-a-uuid", "Sidney Gibson": SIDNEY });
    expect(resolveEstimatorUserId("Alex Koch")).toBeNull();
    expect(resolveEstimatorUserId("Sidney Gibson")).toBe(SIDNEY);
  });
});

describe("existingEstimatorUserId (FK-safety)", () => {
  afterEach(() => {
    delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  });

  it("returns the id only when it is an existing (active) user", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(existingEstimatorUserId("Alex Koch", new Set([ALEX]))).toBe(ALEX);
    // mapped to a valid-format UUID that is NOT a real user -> null (would otherwise FK-violate)
    expect(existingEstimatorUserId("Alex Koch", new Set([SIDNEY]))).toBeNull();
    // unmapped / blank -> null regardless of the valid set
    expect(existingEstimatorUserId("Colby Burling", new Set([ALEX]))).toBeNull();
    expect(existingEstimatorUserId(null, new Set([ALEX]))).toBeNull();
  });

  it("lowercases mapped UUIDs so an uppercase env value still matches Postgres' lowercase ids", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX.toUpperCase() });
    expect(resolveEstimatorUserId("Alex Koch")).toBe(ALEX); // stored lowercased
    expect(existingEstimatorUserId("Alex Koch", new Set([ALEX]))).toBe(ALEX); // matches lowercase user set
  });
});

describe("estimatorRosterUserIds (report roster)", () => {
  afterEach(() => {
    delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  });

  it("is empty when the env is unset (report shows only Other + Missing buckets)", () => {
    expect(estimatorRosterUserIds()).toEqual([]);
  });

  it("returns the distinct mapped user ids", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({
      "Alex Koch": ALEX,
      "Sidney Gibson": SIDNEY,
    });
    expect(estimatorRosterUserIds().sort()).toEqual([ALEX, SIDNEY].sort());
  });

  it("collapses multiple name aliases that map to the same id into one roster entry", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({
      "Alex Koch": ALEX,
      "A. Koch": ALEX,
      "Sidney Gibson": SIDNEY,
    });
    const roster = estimatorRosterUserIds();
    expect(roster).toHaveLength(2);
    expect(new Set(roster)).toEqual(new Set([ALEX, SIDNEY]));
  });

  it("drops malformed entries (only valid mapped ids appear in the roster)", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({
      "Alex Koch": "not-a-uuid",
      "Sidney Gibson": SIDNEY,
    });
    expect(estimatorRosterUserIds()).toEqual([SIDNEY]);
  });
});

/**
 * The `estimates_jobs` directory — the second resolution source.
 *
 * The bug it exists for: a rep flagged "Estimates jobs" in Admin → Users still read as "Missing
 * estimator" on every one of their deals, because the flag fed the dashboard FILTER and nothing else.
 * Linking them meant hand-editing an env var on two Railway services and running a backfill.
 */
describe("buildEstimatorDirectory + flag-driven resolution", () => {
  afterEach(() => {
    delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  });

  it("resolves a flagged user by display name with NO env map configured at all", () => {
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(KASON);
    // and the same call without the directory is still null — the directory is doing the work here
    expect(resolveEstimatorUserId("Kason Reeder")).toBeNull();
  });

  it("normalizes display names the same way it normalizes map keys", () => {
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "  Kason   REEDER " }]);
    expect(resolveEstimatorUserId("kason reeder", directory)).toBe(KASON);
  });

  it("lets the CURATED MAP WIN over a flagged user with the same name", () => {
    // The alias case is the whole reason for the precedence: the Bid Board's spelling may be a name no
    // CRM user carries, and a curated correction must not lose to a coincidental display-name match.
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Kason Reeder": ALEX });
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(ALEX);
  });

  it("still resolves OTHER names from the directory while the map handles its own", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(resolveEstimatorUserId("Alex Koch", directory)).toBe(ALEX);
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(KASON);
  });

  it("refuses to guess when two flagged users share a display name, and drops BOTH", () => {
    // Resolving to whichever row came back first would attribute a deal — and once signed, an additive
    // estimator commission — to the query plan. Dropping only the SECOND would be just as order-dependent.
    const directory = buildEstimatorDirectory([
      { id: KASON, displayName: "Chris Smith" },
      { id: SIDNEY, displayName: "chris  SMITH" },
    ]);
    expect(resolveEstimatorUserId("Chris Smith", directory)).toBeNull();
    expect(directory.byName.has("chris smith")).toBe(false);
    expect(directory.ambiguous.has("chris smith")).toBe(true);
  });

  it("does not treat the SAME user listed twice as ambiguous", () => {
    const directory = buildEstimatorDirectory([
      { id: KASON, displayName: "Kason Reeder" },
      { id: KASON, displayName: "Kason Reeder" },
    ]);
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(KASON);
    expect(directory.ambiguous.size).toBe(0);
  });

  it("skips rows with no usable name or a non-uuid id instead of indexing junk", () => {
    const directory = buildEstimatorDirectory([
      { id: KASON, displayName: null },
      { id: KASON, displayName: "   " },
      { id: "not-a-uuid", displayName: "Bad Row" },
    ]);
    expect(directory.byName.size).toBe(0);
    expect(resolveEstimatorUserId("Bad Row", directory)).toBeNull();
  });

  it("gates FK-safety through the directory too", () => {
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(existingEstimatorUserId("Kason Reeder", new Set([KASON]), directory)).toBe(KASON);
    expect(existingEstimatorUserId("Kason Reeder", new Set([ALEX]), directory)).toBeNull();
  });
});

describe("isEstimatorResolutionConfigured (the gate the ingest must use)", () => {
  afterEach(() => {
    delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  });

  it("opens on a populated DIRECTORY even with the env map unset", () => {
    // The load-bearing one, and why the former env-only isEstimatorMapConfigured() was replaced rather
    // than kept alongside: it would report false here and the ingest would skip resolution entirely on
    // a server carrying its roster in the flags.
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(isEstimatorResolutionConfigured(directory)).toBe(true);
  });

  it("stays CLOSED when neither source can resolve anything, so ingest preserves existing ids", () => {
    expect(isEstimatorResolutionConfigured(buildEstimatorDirectory([]))).toBe(false);
    expect(isEstimatorResolutionConfigured(undefined)).toBe(false);
    // an all-ambiguous directory resolves nothing, so it must not open the gate either
    const ambiguousOnly = buildEstimatorDirectory([
      { id: KASON, displayName: "Chris Smith" },
      { id: SIDNEY, displayName: "Chris Smith" },
    ]);
    expect(isEstimatorResolutionConfigured(ambiguousOnly)).toBe(false);
  });

  it("still opens on the env map alone, as before this change", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(isEstimatorResolutionConfigured(buildEstimatorDirectory([]))).toBe(true);
  });
});
