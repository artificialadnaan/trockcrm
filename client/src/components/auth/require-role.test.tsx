import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RequireRole } from "./require-role";

let mockRole: "admin" | "director" | "rep" = "admin";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      email: `${mockRole}@trock.dev`,
      displayName: `${mockRole} user`,
      role: mockRole,
      officeId: "office-1",
    },
  }),
}));

function renderGuard(allowedRoles: readonly ("admin" | "director" | "rep")[]) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <RequireRole allowedRoles={allowedRoles}>
        <div>Protected content</div>
      </RequireRole>
    </MemoryRouter>,
  );
}

describe("RequireRole", () => {
  it("renders children when the user has an allowed role", () => {
    mockRole = "admin";

    expect(renderGuard(["admin"])).toContain("Protected content");
  });

  it("renders children when the user is allowed through a shared role set", () => {
    mockRole = "director";

    expect(renderGuard(["admin", "director"])).toContain("Protected content");
  });

  it("redirects to the fallback route when the user is unauthorized", () => {
    mockRole = "rep";

    expect(renderGuard(["admin"])).not.toContain("Protected content");
  });
});
