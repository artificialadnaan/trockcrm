import { describe, expect, it } from "vitest";
import {
  CRM_ONLY_TENANT_ROUTE_MOUNTS,
  FIELD_ACCESSIBLE_ROUTE_MOUNTS,
  PUBLIC_ROUTE_MOUNTS,
} from "../src/route-access-policy.js";

describe("field contractor route policy", () => {
  it("keeps every current CRM tenant route behind the CRM-only policy with field routes explicitly allowlisted", () => {
    expect(CRM_ONLY_TENANT_ROUTE_MOUNTS).toEqual([
      "/deals",
      "/pipeline",
      "/contacts",
      "/leads",
      "/projects",
      "/email",
      "/call-recordings",
      "/tasks",
      "/users",
      "/activities",
      "/notifications",
      "/reports",
      "/commissions",
      "/sales-review",
      "/dashboard",
      "/procore",
      "/search",
      "/companies",
      "/properties",
      "/companycam",
      "/ai",
      "/usage",
      "/field-responders",
    ]);
    expect(FIELD_ACCESSIBLE_ROUTE_MOUNTS).toEqual(["/api/field"]);
    expect(PUBLIC_ROUTE_MOUNTS).toContain("/api/auth");
  });
});
