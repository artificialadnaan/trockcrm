import { describe, expect, it } from "vitest";
import { validateOptionalExpectedCloseDateInput } from "../../../src/modules/deals/expected-close-date-input.js";
import { AppError } from "../../../src/middleware/error-handler.js";

// Input validation for the OPTIONAL expectedCloseDate carried by the stage-change request body.
// A malformed value must produce a clean 400 here, never coerce through to the Postgres date write
// (which would surface as a generic 500).
describe("validateOptionalExpectedCloseDateInput", () => {
  it("is a no-op when the field is absent or empty", () => {
    expect(() => validateOptionalExpectedCloseDateInput(undefined)).not.toThrow();
    expect(() => validateOptionalExpectedCloseDateInput(null)).not.toThrow();
    expect(() => validateOptionalExpectedCloseDateInput("")).not.toThrow();
  });

  it("accepts a real ISO calendar date string", () => {
    expect(() => validateOptionalExpectedCloseDateInput("2026-12-01")).not.toThrow();
    expect(() => validateOptionalExpectedCloseDateInput("2026-02-28")).not.toThrow();
  });

  it("rejects a non-string value (e.g. a JSON array) with a 400 instead of letting it coerce through", () => {
    // ['2026-12-01'] coerces to "2026-12-01" via RegExp.test + template strings, so a typeof guard
    // is required to stop it reaching changeDealStage and the date column as a 500.
    for (const bad of [["2026-12-01"], 20261201, { value: "2026-12-01" }, true] as unknown[]) {
      let thrown: unknown;
      try {
        validateOptionalExpectedCloseDateInput(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(400);
    }
  });

  it("rejects a malformed shape with a 400", () => {
    for (const bad of ["2026-1-1", "not-a-date", "26-12-01", "2026/12/01"]) {
      let thrown: unknown;
      try {
        validateOptionalExpectedCloseDateInput(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(400);
    }
  });

  it("rejects a well-shaped but impossible calendar date with a 400", () => {
    for (const bad of ["2026-99-99", "2026-02-30", "2026-13-01", "2026-00-10"]) {
      let thrown: unknown;
      try {
        validateOptionalExpectedCloseDateInput(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(400);
    }
  });
});
