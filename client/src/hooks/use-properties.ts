import { useMemo } from "react";
import { useCompanies, type Company } from "@/hooks/use-companies";
import { useDeals, type Deal } from "@/hooks/use-deals";
import {
  buildPropertyId,
  formatPropertyLabel,
} from "@/lib/property-key";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

export interface PropertyDeal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  companyId: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  lastActivityAt: string | null;
  stageEnteredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PropertySurface {
  id: string;
  companyId: string | null;
  companyName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  label: string;
  dealCount: number;
  leadCount: number;
  lastActivityAt: string | null;
  leadDealId: string | null;
  dealIds: string[];
  leadIds: string[];
}

export interface PropertyDetailSurface extends PropertySurface {
  deals: PropertyDeal[];
}

function buildCompanyMap(companies: Company[]) {
  return new Map(companies.map((company) => [company.id, company]));
}

function isLeadDeal(stageId: string, ddStageId: string | null) {
  return ddStageId != null && stageId === ddStageId;
}

export function buildPropertySurfaces(
  deals: Deal[],
  companies: Company[],
  ddStageId: string | null
): PropertySurface[] {
  const companyMap = buildCompanyMap(companies);
  const properties = new Map<string, PropertySurface>();

  for (const deal of deals) {
    const id = buildPropertyId({
      companyId: deal.companyId ?? null,
      address: deal.propertyAddress,
      city: deal.propertyCity,
      state: deal.propertyState,
      zip: deal.propertyZip,
    });
    const companyName = deal.companyId ? companyMap.get(deal.companyId)?.name ?? null : null;
    const existing = properties.get(id);
    const dealIsLead = isLeadDeal(deal.stageId, ddStageId);
    const label = formatPropertyLabel({
      address: deal.propertyAddress,
      city: deal.propertyCity,
      state: deal.propertyState,
      zip: deal.propertyZip,
    });

    if (existing) {
      existing.dealIds.push(deal.id);
      if (dealIsLead) {
        existing.leadIds.push(deal.id);
      }
      existing.dealCount += 1;
      if (dealIsLead) existing.leadCount += 1;
      if (!existing.companyName && companyName) existing.companyName = companyName;
      if (
        deal.lastActivityAt &&
        (!existing.lastActivityAt || new Date(deal.lastActivityAt).getTime() > new Date(existing.lastActivityAt).getTime())
      ) {
        existing.lastActivityAt = deal.lastActivityAt;
      }
      continue;
    }

    properties.set(id, {
      id,
      companyId: deal.companyId ?? null,
      companyName,
      address: deal.propertyAddress ?? null,
      city: deal.propertyCity ?? null,
      state: deal.propertyState ?? null,
      zip: deal.propertyZip ?? null,
      label,
      dealCount: 1,
      leadCount: dealIsLead ? 1 : 0,
      lastActivityAt: deal.lastActivityAt ?? null,
      leadDealId: dealIsLead ? deal.id : null,
      dealIds: [deal.id],
      leadIds: dealIsLead ? [deal.id] : [],
    });
  }

  return [...properties.values()].sort((a, b) => {
    const left = `${a.companyName ?? ""} ${a.label}`.toLowerCase();
    const right = `${b.companyName ?? ""} ${b.label}`.toLowerCase();
    return left.localeCompare(right);
  });
}

export function useProperties(options: { search?: string; limit?: number; page?: number } = {}) {
  const { deals, loading: dealsLoading, error: dealsError } = useDeals({
    isActive: true,
    limit: options.limit ?? 2000,
    page: 1,
    sortBy: "updated_at",
    sortDir: "desc",
  });
  const { companies, loading: companiesLoading, error: companiesError } = useCompanies({
    limit: options.limit ?? 2000,
    page: 1,
  });
  const { stages } = usePipelineStages();

  const ddStageId = stages.find((stage) => stage.slug === "dd")?.id ?? null;

  const properties = useMemo(() => {
    const grouped = buildPropertySurfaces(deals, companies, ddStageId);
    const search = options.search?.trim().toLowerCase();
    const filtered = search
      ? grouped.filter((property) => {
          const haystack = [
            property.companyName,
            property.label,
            property.address,
            property.city,
            property.state,
            property.zip,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(search);
        })
      : grouped;

    return filtered;
  }, [deals, companies, ddStageId, options.search]);

  return {
    properties,
    loading: dealsLoading || companiesLoading,
    error: dealsError ?? companiesError,
  };
}

export function usePropertyDetail(propertyId: string | undefined) {
  const { properties, loading, error } = useProperties();

  const property = useMemo(() => properties.find((item) => item.id === propertyId) ?? null, [properties, propertyId]);
  const relatedDeals = property
    ? property.dealIds
    : [];

  return { property, relatedDeals, loading, error };
}
