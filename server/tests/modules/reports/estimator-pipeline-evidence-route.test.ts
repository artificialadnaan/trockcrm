import { describe, expect, it } from "vitest";
import { parseEstimatorPipelineEvidenceQuery } from "../../../src/modules/reports/routes.js";

// estimatorKey is now the estimator's CRM user id (a UUID), not a fixed literal key.
const ESTIMATOR_A = "00000000-0000-0000-0000-000000005101";
const ESTIMATOR_B = "00000000-0000-0000-0000-000000005102";

describe("parseEstimatorPipelineEvidenceQuery", () => {
  it("defaults evidence to the open cohort and validates an explicit cohort", () => {
    expect(parseEstimatorPipelineEvidenceQuery({ bucket: "missing" }).cohort).toBe("open");
    expect(parseEstimatorPipelineEvidenceQuery({ bucket: "missing", cohort: "won" }).cohort).toBe("won");
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "missing", cohort: "lost" })).toThrow(
      /cohort/,
    );
  });

  it("requires one of the report's three evidence buckets", () => {
    expect(() => parseEstimatorPipelineEvidenceQuery({})).toThrow(/bucket/);
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "everyone" })).toThrow(/bucket/);
  });

  it("requires a valid user-id key for target drills and rejects keys on aggregate buckets", () => {
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "target" })).toThrow(/estimatorKey/);
    // A non-UUID estimatorKey on a target drill is rejected at the route.
    expect(() =>
      parseEstimatorPipelineEvidenceQuery({ bucket: "target", estimatorKey: "sidney_gibson" }),
    ).toThrow(/estimatorKey/);

    for (const bucket of ["other", "missing"] as const) {
      expect(() =>
        parseEstimatorPipelineEvidenceQuery({ bucket, estimatorKey: ESTIMATOR_A }),
      ).toThrow(/estimatorKey/);
    }
  });

  it("accepts a valid user-id target key and applies pagination defaults", () => {
    for (const estimatorKey of [ESTIMATOR_A, ESTIMATOR_B]) {
      expect(parseEstimatorPipelineEvidenceQuery({ bucket: "target", estimatorKey })).toEqual({
        cohort: "open",
        asOf: undefined,
        bucket: "target",
        estimatorKey,
        stageSlug: undefined,
        page: 1,
        pageSize: 25,
      });
    }
    expect(parseEstimatorPipelineEvidenceQuery({ bucket: "missing" })).toEqual({
      cohort: "open",
      asOf: undefined,
      bucket: "missing",
      estimatorKey: undefined,
      stageSlug: undefined,
      page: 1,
      pageSize: 25,
    });
  });

  it("trims a canonical stage slug and parses bounded positive pagination", () => {
    expect(
      parseEstimatorPipelineEvidenceQuery({
        cohort: "won",
        asOf: "2026-07-13",
        bucket: "target",
        estimatorKey: ESTIMATOR_B,
        stageSlug: "  won  ",
        page: ["3", "4"],
        pageSize: "100",
      }),
    ).toEqual({
      cohort: "won",
      asOf: "2026-07-13",
      bucket: "target",
      estimatorKey: ESTIMATOR_B,
      stageSlug: "won",
      page: 3,
      pageSize: 100,
    });
  });

  it("rejects malformed stage slugs and invalid pagination", () => {
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "missing", asOf: "2026-07-13" })).toThrow(
      /asOf.*cohort=won/,
    );
    for (const asOf of ["07-13-2026", "2026-02-30"]) {
      expect(() => parseEstimatorPipelineEvidenceQuery({ cohort: "won", bucket: "missing", asOf })).toThrow(
        /asOf/,
      );
    }

    for (const stageSlug of ["Estimate-Sent", "stage name", "won;drop_table", "x".repeat(101)]) {
      expect(() =>
        parseEstimatorPipelineEvidenceQuery({ bucket: "missing", stageSlug }),
      ).toThrow(/stageSlug/);
    }

    for (const page of ["0", "100001", "1.5", "abc", 2]) {
      expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "missing", page })).toThrow(/page/);
    }
    for (const pageSize of ["0", "101", "2.5", "abc", 25]) {
      expect(() =>
        parseEstimatorPipelineEvidenceQuery({ bucket: "missing", pageSize }),
      ).toThrow(/pageSize/);
    }
  });
});
