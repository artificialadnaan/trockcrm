// @vitest-environment jsdom
//
// Inactive user rows used to be muted with `opacity-50`, which composites EVERY cell against the page
// background: the Inactive badge fell to 2.24:1, the row's primary text to 3.41 and its secondary text to
// 1.97 — all below the 4.5:1 AA floor for text this size. Because a child cannot opt out of an ancestor's
// opacity, the badge's own colour could not be fixed while the row opacity stayed.
//
// This pins the shape of the fix rather than the colour: mute by BACKGROUND, never by opacity. It is a
// one-token regression away at all times, and the failure it guards is invisible in a screenshot.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Read from disk rather than importing: the property under test is the className the row is WRITTEN with,
// and jsdom has no compositing model to measure the resulting contrast with.
const source = readFileSync(path.resolve(process.cwd(), "src/pages/admin/users-page.tsx"), "utf8");

describe("inactive user rows", () => {
  it("are muted with a background, not with opacity", () => {
    const row = source.slice(source.indexOf("<TableRow key={user.id}"));
    const openingTag = row.slice(0, row.indexOf(">") + 1);

    expect(openingTag).toContain("!user.isActive");
    expect(openingTag).toContain("bg-slate-50");
    expect(openingTag).not.toContain("opacity");
  });

  it("keeps the status badge off the failing gray-500 token", () => {
    expect(source).toContain('bg-gray-100 text-xs text-gray-600');
    expect(source).not.toContain('bg-gray-100 text-xs text-gray-500');
  });
});
