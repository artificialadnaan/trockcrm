import { describe, expect, it } from "vitest";
import { resolveWonClosedDateWriteThrough } from "../../../src/modules/shared/won-close-date.js";

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
