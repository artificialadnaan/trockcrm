import { shareProjectPhotos, type Fetcher } from "../endpoints";
import { buildShareMessage } from "../../projects/share-message";

describe("shareProjectPhotos", () => {
  it("POSTs the selected photoIds to the project share endpoint and returns the link", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    const fetcher: Fetcher = (async (path: string, opts: unknown) => {
      calls.push({ path, opts });
      return { url: "https://app.test/p/raw-token", token: { id: "tok-1", expiresAt: "2026-06-20T00:00:00.000Z" }, photoCount: 2 };
    }) as Fetcher;

    const result = await shareProjectPhotos(fetcher, "deal-1", { photoIds: ["a", "b"] });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/field/projects/deal-1/share");
    expect(calls[0].opts).toMatchObject({ method: "POST", body: { photoIds: ["a", "b"] } });
    expect(result.url).toBe("https://app.test/p/raw-token");
    expect(result.photoCount).toBe(2);
    expect(result.token.expiresAt).toBe("2026-06-20T00:00:00.000Z");
  });
});

describe("buildShareMessage", () => {
  it("pluralizes the photo count and includes the url", () => {
    expect(buildShareMessage("https://x/p/t", 1)).toContain("1 photo:");
    expect(buildShareMessage("https://x/p/t", 1)).not.toContain("photos");
    expect(buildShareMessage("https://x/p/t", 3)).toContain("3 photos:");
    expect(buildShareMessage("https://x/p/t", 2)).toContain("https://x/p/t");
  });
});
