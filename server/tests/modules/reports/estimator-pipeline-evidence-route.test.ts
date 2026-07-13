import { describe, expect, it } from "vitest";
import { parseEstimatorPipelineEvidenceQuery } from "../../../src/modules/reports/routes.js";

describe("parseEstimatorPipelineEvidenceQuery", () => {
  it("requires one of the report's three evidence buckets", () => {
    expect(() => parseEstimatorPipelineEvidenceQuery({})).toThrow(/bucket/);
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "everyone" })).toThrow(/bucket/);
  });

  it("requires a configured key for target drills and rejects keys on aggregate buckets", () => {
    expect(() => parseEstimatorPipelineEvidenceQuery({ bucket: "target" })).toThrow(/estimatorKey/);
    expect(() =>
      parseEstimatorPipelineEvidenceQuery({ bucket: "target", estimatorKey: "unknown_estimator" }),
    ).toThrow(/estimatorKey/);

    for (const bucket of ["other", "missing"] as const) {
      expect(() =>
        parseEstimatorPipelineEvidenceQuery({ bucket, estimatorKey: "sidney_gibson" }),
      ).toThrow(/estimatorKey/);
    }
  });

  it("accepts each configured target and applies pagination defaults", () => {
    for (const estimatorKey of ["sidney_gibson", "alex_koch"] as const) {
      expect(parseEstimatorPipelineEvidenceQuery({ bucket: "target", estimatorKey })).toEqual({
        bucket: "target",
        estimatorKey,
        stageSlug: undefined,
        page: 1,
        pageSize: 25,
      });
    }
    expect(parseEstimatorPipelineEvidenceQuery({ bucket: "missing" })).toEqual({
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
        bucket: "target",
        estimatorKey: "alex_koch",
        stageSlug: "  service_estimating  ",
        page: ["3", "4"],
        pageSize: "100",
      }),
    ).toEqual({
      bucket: "target",
      estimatorKey: "alex_koch",
      stageSlug: "service_estimating",
      page: 3,
      pageSize: 100,
    });
  });

  it("rejects malformed stage slugs and invalid pagination", () => {
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
