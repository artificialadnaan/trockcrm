import { describe, expect, it } from "vitest";
import appShellSource from "./app-shell.tsx?raw";

describe("AppShell layout", () => {
  it("wraps routed content in a shared page stack container", () => {
    expect(appShellSource).toContain(
      '<main className="flex-1 overflow-auto bg-slate-50 p-4 pb-20 md:p-6 md:pb-6">',
    );
    expect(appShellSource).toContain('<div className="space-y-6">');
    expect(appShellSource).toContain("<Outlet />");
  });
});
