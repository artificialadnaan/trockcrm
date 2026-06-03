import { afterEach, describe, expect, it } from "vitest";

import {
  BID_BOARD_ESTIMATOR_USER_MAP_ENV,
  existingEstimatorUserId,
  isEstimatorMapConfigured,
  resolveEstimatorUserId,
} from "../../../src/modules/bid-board-sync/estimator-map.js";

const ALEX = "636fd7e9-2575-4826-b11d-2869b24a12cf";
const SIDNEY = "829fad98-af4c-4acf-ad53-6625e9c0bd32";

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

describe("isEstimatorMapConfigured", () => {
  afterEach(() => {
    delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  });

  it("is false when unset/empty/malformed (ingest then PRESERVES existing ids), true when configured", () => {
    expect(isEstimatorMapConfigured()).toBe(false);
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = "not json";
    expect(isEstimatorMapConfigured()).toBe(false);
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": "not-a-uuid" });
    expect(isEstimatorMapConfigured()).toBe(false); // no valid entries
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Alex Koch": ALEX });
    expect(isEstimatorMapConfigured()).toBe(true);
  });
});
