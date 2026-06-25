/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerPhotoDownloads } from "./download";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("triggerPhotoDownloads", () => {
  it("creates a staggered <a download> per file with the right href + filename", () => {
    vi.useFakeTimers();
    const clicks: Array<{ href: string; download: string }> = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });

    triggerPhotoDownloads(
      [
        { url: "https://r2.example/a.jpg?sig=1", filename: "a.jpg" },
        { url: "https://r2.example/b.jpg?sig=2", filename: "b.jpg" },
      ],
      100,
    );

    // First fires immediately (index 0), the rest are staggered.
    vi.advanceTimersByTime(0);
    expect(clicks).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(clicks).toHaveLength(2);

    expect(clicks[0]).toMatchObject({ href: "https://r2.example/a.jpg?sig=1", download: "a.jpg" });
    expect(clicks[1].download).toBe("b.jpg");
    // The temporary anchors are cleaned up.
    expect(document.querySelectorAll("a").length).toBe(0);
    clickSpy.mockRestore();
  });

  it("skips entries with no url", () => {
    vi.useFakeTimers();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    triggerPhotoDownloads([{ url: "", filename: "x.jpg" }], 100);
    vi.advanceTimersByTime(1000);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
