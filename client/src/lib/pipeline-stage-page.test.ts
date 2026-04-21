import { describe, expect, it } from "vitest";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

describe("normalizeStagePageQuery", () => {
  it("normalizes an invalid stage sort back to age_desc", () => {
    expect(
      normalizeStagePageQuery({
        sort: "bad",
        page: "wat",
        search: "acme",
        staleOnly: "true",
        workflowRoute: "service",
      })
    ).toEqual({
      page: 1,
      pageSize: 25,
      sort: "age_desc",
      search: "acme",
      filters: {
        assignedRepId: undefined,
        staleOnly: true,
        status: undefined,
        workflowRoute: "service",
        source: undefined,
      },
    });
  });
});
