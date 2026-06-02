import { describe, expect, it } from "vitest";
import {
  effectiveContractSignedDate,
  resolveWonClosedDateWriteThrough,
} from "../../../src/modules/shared/won-close-date.js";

/**
 * The "effective" contract-signed date matches the app's canonical basis
 * COALESCE(contract_signed_at::date, contract_signed_date) under a UTC session — so the
 * write-through agrees with how reports/commissions read contract-signed, including rows the
 * reseed path set via contract_signed_at alone (contract_signed_date null).
 */
describe("effectiveContractSignedDate", () => {
  it("prefers contract_signed_at::date (UTC) when present", () => {
    expect(
      effectiveContractSignedDate("2026-02-20", new Date("2026-02-15T00:00:00.000Z"))
    ).toBe("2026-02-15");
  });

  it("falls back to contract_signed_date when contract_signed_at is null", () => {
    expect(effectiveContractSignedDate("2026-02-20", null)).toBe("2026-02-20");
  });

  it("uses contract_signed_at alone when contract_signed_date is null (reseed-only rows)", () => {
    expect(
      effectiveContractSignedDate(null, new Date("2026-03-09T18:30:00.000Z"))
    ).toBe("2026-03-09");
  });

  it("returns null when both are absent", () => {
    expect(effectiveContractSignedDate(null, null)).toBeNull();
  });
});

/**
 * Unit proof for the WRITE-TIME contract-signed override rule (always-when-present).
 *
 * Accounting's contract-signed date is the correction lever for a Won-family deal's
 * effective won-close date. When present it ALWAYS wins; when absent the stage-driven
 * won date stands. Won-family gating is the CALLER's responsibility — this resolver only
 * encodes the "contract-signed wins when present" precedence so every writer path
 * (changeDealStage, the Procore mirror, setDealContractSignedDate) shares ONE definition.
 */
describe("resolveWonClosedDateWriteThrough (always-when-present)", () => {
  it("contract-signed date wins over the stage-driven won date when present", () => {
    expect(
      resolveWonClosedDateWriteThrough({
        contractSignedDate: "2026-02-15",
        stageDrivenWonDate: "2026-03-10",
      })
    ).toBe("2026-02-15");
  });

  it("falls back to the stage-driven won date when contract-signed is null", () => {
    expect(
      resolveWonClosedDateWriteThrough({
        contractSignedDate: null,
        stageDrivenWonDate: "2026-03-10",
      })
    ).toBe("2026-03-10");
  });

  it("returns null when both the contract-signed and stage-driven dates are absent", () => {
    expect(
      resolveWonClosedDateWriteThrough({
        contractSignedDate: null,
        stageDrivenWonDate: null,
      })
    ).toBeNull();
  });

  it("treats undefined / empty-string contract-signed as absent (falls back)", () => {
    expect(
      resolveWonClosedDateWriteThrough({
        contractSignedDate: undefined,
        stageDrivenWonDate: "2026-03-10",
      })
    ).toBe("2026-03-10");
    expect(
      resolveWonClosedDateWriteThrough({
        contractSignedDate: "",
        stageDrivenWonDate: "2026-03-10",
      })
    ).toBe("2026-03-10");
  });
});
