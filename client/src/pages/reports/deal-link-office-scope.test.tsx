// Pins the deal-link office rule for BOTH shared DealLink components:
//
//   ?officeId verbatim, or nothing. Never derived from ?office.
//
// Both halves matter and they fail in opposite directions:
//   - Dropping a present ?officeId sends the detail request to the viewer's default schema, 404-ing a
//     deal that exists only in the scoped one. (This is what both components used to do.)
//   - Deriving an officeId from ?office promotes a report PREDICATE into a tenant switch. ?office is
//     evaluated inside the current tenant and matches on the activity's responsible user, so it says
//     nothing about which schema a deal lives in; synthesising a scope from it causes the same 404
//     from the other side. The negative cases below are what stop a future edit "helpfully" doing it.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DealLink as PerformanceDealLink } from "./performance-report-ui";
import { DealLink as OperationsDealLink } from "./operations-report-common";

const COMPONENTS = [
  ["performance-report-ui", PerformanceDealLink],
  ["operations-report-common", OperationsDealLink],
] as const;

function hrefFor(Component: (typeof COMPONENTS)[number][1], search: string) {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/reports/whatever${search}`]}>
      <Component dealId="deal-9">Some Deal</Component>
    </MemoryRouter>
  );
  return /href="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe.each(COMPONENTS)("%s DealLink office scope", (_name, Component) => {
  it("carries an explicit ?officeId verbatim", () => {
    expect(hrefFor(Component, "?officeId=office-atlanta")).toBe("/deals/deal-9?officeId=office-atlanta");
  });

  it("carries nothing when there is no office scope", () => {
    expect(hrefFor(Component, "")).toBe("/deals/deal-9");
  });

  it("never synthesises an officeId from the ?office report filter", () => {
    // Every shape ReportFilterBar or a legacy URL can produce. None may become a tenant scope.
    for (const value of ["atlanta", "office-atlanta", "ATLANTA", "Atlanta%20Office", "all"]) {
      expect(hrefFor(Component, `?office=${value}`)).toBe("/deals/deal-9");
    }
  });

  it("uses the tenant scope and ignores the filter when both are present", () => {
    expect(hrefFor(Component, "?officeId=office-atlanta&office=dallas")).toBe(
      "/deals/deal-9?officeId=office-atlanta"
    );
  });

  it("encodes an officeId that needs escaping rather than emitting it raw", () => {
    expect(hrefFor(Component, "?officeId=a%20b%26c")).toBe("/deals/deal-9?officeId=a%20b%26c");
  });

  it("trims a padded officeId the same way api() does", () => {
    // api()'s readOfficeIdFromLocation trims before setting x-office-id, so a padded value still
    // FETCHES correctly. If the link kept the padding, DealDetailPage would read it raw and pass it
    // to getOfficeRequestOptions — which sets the header itself and bypasses api()'s trim — and auth
    // rejects an office id with spaces. Rows load, every link 401s: a symptom pointing nowhere near
    // the cause.
    expect(hrefFor(Component, "?officeId=%20office-b%20")).toBe("/deals/deal-9?officeId=office-b");
  });

  it("treats a whitespace-only officeId as absent, not as a scope", () => {
    expect(hrefFor(Component, "?officeId=%20%20")).toBe("/deals/deal-9");
  });
});
