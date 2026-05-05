import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { geocodingCache } from "../../../../shared/src/schema/index.js";

describe("geocoding cache schema", () => {
  it("models rounded coordinates as the composite cache key", () => {
    const columns = getTableColumns(geocodingCache);
    const config = getTableConfig(geocodingCache);

    expect(columns.latitude.name).toBe("latitude");
    expect(columns.longitude.name).toBe("longitude");
    expect(columns.provider.default).toBe("google_geocoding");
    expect(columns.address.notNull).toBe(false);
    expect(columns.formattedComponents.name).toBe("formatted_components");
    expect(columns.cachedAt.hasDefault).toBe(true);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0].getName()).toBe("geocoding_cache_latitude_longitude_provider_pk");
    expect(config.indexes.map((idx) => idx.config.name)).toContain("geocoding_cache_cached_at_idx");
  });
});
