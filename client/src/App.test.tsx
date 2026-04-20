import { describe, expect, it } from "vitest";
import appSource from "./App.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("App route guards", () => {
  const source = normalize(appSource);

  it("wraps shared director routes with admin and director access", () => {
    expect(source).toContain('path="/director" element={( <RequireRole allowedRoles={["admin", "director"]}> <DirectorDashboardPage />');
    expect(source).toContain('path="/director/rep/:repId" element={( <RequireRole allowedRoles={["admin", "director"]}> <DirectorRepDetail />');
  });

  it("wraps admin-only routes with the RequireRole guard", () => {
    expect(source).toContain('path="/admin/users" element={( <RequireRole allowedRoles={["admin"]}> <UsersPage />');
    expect(source).toContain('path="/admin/offices" element={( <RequireRole allowedRoles={["admin"]}> <OfficesPage />');
    expect(source).toContain('path="/help/admin-guide" element={( <RequireRole allowedRoles={["admin"]}> <AdminGuidePage />');
  });

  it("opens migration tooling to directors and admins", () => {
    expect(source).toContain('path="/admin/migration" element={( <RequireRole allowedRoles={["admin", "director"]}> <MigrationDashboardPage />');
  });
});
