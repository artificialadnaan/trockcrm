import { getNearbyCaptureTargets } from "../endpoints";
import type { Fetcher } from "../endpoints";

describe("api endpoints", () => {
  it("requests nearby capture targets with coordinates and a limit", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { targets: [] } as never;
    };

    await getNearbyCaptureTargets(fetcher, { latitude: 32.911, longitude: -96.775, limit: 3 });

    expect(calls).toEqual([{
      path: "/field/photo-targets/nearby",
      opts: { query: { lat: 32.911, lng: -96.775, limit: 3 } },
    }]);
  });
});
