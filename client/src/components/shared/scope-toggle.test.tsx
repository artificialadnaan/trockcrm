import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopeToggle } from "./scope-toggle";

const options = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
] as const;

describe("ScopeToggle sizing", () => {
  it("default keeps the original compact pill and no enlarged tap target", () => {
    const html = renderToStaticMarkup(
      <ScopeToggle options={options} value="mine" onChange={() => {}} />,
    );
    expect(html).toContain("px-3.5 py-1.5 text-xs");
    expect(html).not.toContain("min-h-[44px]");
  });

  it("touch enforces a >=44px tap target on phones and reverts to compact at >=md", () => {
    const html = renderToStaticMarkup(
      <ScopeToggle options={options} value="mine" onChange={() => {}} size="touch" />,
    );
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("md:min-h-0");
    expect(html).toContain("md:px-3.5 md:py-1.5 md:text-xs");
  });
});
