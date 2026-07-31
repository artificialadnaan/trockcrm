import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Separator } from "./separator";

/**
 * The separator's ONLY sizing comes from its orientation-conditional classes, so a selector that does not
 * match the rendered attribute makes the component invisible rather than merely unstyled — and nothing
 * else in the app would fail. This pins the class to the attribute Base UI actually emits.
 *
 * It has been wrong twice: first as Tailwind v4 bare-variant syntax (`data-horizontal:`) that a v3 build
 * dropped entirely, then as valid v3 syntax (`data-[horizontal]:`) still aimed at an attribute that does
 * not exist. Both looked right in the source.
 */
describe("Separator sizing is conditioned on the attribute it actually renders", () => {
  it.each([
    ["horizontal", ["h-px", "w-full"]],
    ["vertical", ["w-px", "self-stretch"]],
  ] as const)("%s", (orientation, utilities) => {
    const html = renderToStaticMarkup(<Separator orientation={orientation} />);

    expect(html).toContain(`data-orientation="${orientation}"`);
    for (const utility of utilities) {
      expect(html).toContain(`data-[orientation=${orientation}]:${utility}`);
    }
    // The old, non-existent attribute form must not come back.
    expect(html).not.toContain(`data-[${orientation}]:`);
  });
});
