import { getDealRegionForState } from "@trock-crm/shared/types";
import type { Region } from "@/hooks/use-pipeline-config";

export function resolveRegionIdForState(regions: Region[], state: unknown): string {
  const dealRegion = getDealRegionForState(state);
  if (!dealRegion) return "";

  const match = regions.find(
    (region) => region.slug === dealRegion.slug || region.name === dealRegion.name
  );
  return match?.id ?? "";
}

export function applyDealRegionAutoSelection(input: {
  regions: Region[];
  propertyState: unknown;
  currentRegionId: string;
  manualOverride: boolean;
}): string {
  if (input.manualOverride) return input.currentRegionId;
  return resolveRegionIdForState(input.regions, input.propertyState);
}
