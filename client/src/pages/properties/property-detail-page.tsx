import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Activity,
  Building2,
  Camera,
  ClipboardList,
  Edit,
  ExternalLink,
  FileText,
  Handshake,
  Hash,
  Images,
  MapPin,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DetailPageShell,
  DetailRailItem,
  DetailRailSection,
  type DetailPageShellKpi,
  type DetailPageShellTab,
} from "@/components/layout/detail-page-shell";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import {
  formatPropertyLabel,
  usePropertyDetail,
  type PropertyDeal,
  type PropertyLead,
  type PropertySurface,
} from "@/hooks/use-properties";
import { cn } from "@/lib/utils";

type PropertyTab = "overview" | "photos" | "contacts" | "deals" | "leads" | "activity" | "files" | "companycam";

const PROPERTY_TABS: Array<{ id: PropertyTab; label: string; icon: ReactNode }> = [
  { id: "overview", label: "Overview", icon: <FileText className="h-4 w-4" /> },
  { id: "photos", label: "Photos", icon: <Images className="h-4 w-4" /> },
  { id: "contacts", label: "Contacts", icon: <Users className="h-4 w-4" /> },
  { id: "deals", label: "Deals", icon: <Handshake className="h-4 w-4" /> },
  { id: "leads", label: "Leads", icon: <ClipboardList className="h-4 w-4" /> },
  { id: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { id: "files", label: "Files", icon: <FileText className="h-4 w-4" /> },
  { id: "companycam", label: "CompanyCam", icon: <Camera className="h-4 w-4" /> },
];

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatTypeBadge(value: string | null | undefined) {
  if (!value) return "UNCATEGORIZED";
  return titleCase(value).toUpperCase();
}

function formatTypeLabel(value: string | null | undefined) {
  if (!value) return "Not categorized";
  return titleCase(value);
}

function formatAddressLine(property: Pick<PropertySurface, "address" | "city" | "state" | "zip" | "name">) {
  return formatPropertyLabel(property);
}

function formatCityLine(property: Pick<PropertySurface, "city" | "state" | "zip">) {
  return [[property.city, property.state].filter(Boolean).join(", "), property.zip].filter(Boolean).join(" ");
}

function formatNullable(value: string | number | null | undefined, fallback = "Not set") {
  if (value == null || value === "") return fallback;
  return String(value);
}

function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 0,
  }).format(value);
}

function parseMoney(value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrencyCompact(value: string | number | null | undefined) {
  const amount = parseMoney(value);
  if (amount == null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

function bestDealValue(deal: PropertyDeal) {
  return parseMoney(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate);
}

function buildCompanyCamUrl(companycamProjectId: string | null | undefined) {
  if (!companycamProjectId) return null;
  return `https://app.companycam.com/projects/${encodeURIComponent(companycamProjectId)}`;
}

function buildProcorePropertyUrl(procorePropertyId: string | null | undefined) {
  if (!procorePropertyId) return null;
  return `https://app.procore.com/properties/${encodeURIComponent(procorePropertyId)}`;
}

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { property, leads, deals, loading, error } = usePropertyDetail(id);
  const [activeTab, setActiveTab] = useState<PropertyTab>("overview");

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 rounded bg-muted animate-pulse" />
        <div className="h-64 rounded-lg bg-muted animate-pulse" />
        <div className="h-72 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Property not found"}</p>
        <Link to="/properties" className={cn(buttonVariants({ variant: "outline" }), "mt-4")}>
          Back to Properties
        </Link>
      </div>
    );
  }

  const relatedLeads = leads;
  const relatedDeals = deals;
  const activeDeals = relatedDeals.filter((deal) => deal.isActive);
  const propertyTypeLabel = formatTypeLabel(property.propertyType ?? property.type ?? null);
  const propertyTypeBadge = formatTypeBadge(property.propertyType ?? property.type ?? null);
  const addressLine = formatAddressLine(property);
  const cityLine = formatCityLine(property);
  const companyCamUrl = buildCompanyCamUrl(property.companycamProjectId ?? property.companycamId);
  const procorePropertyUrl = buildProcorePropertyUrl(property.procorePropertyId ?? property.procoreId);
  const activePipelineValue =
    formatCurrencyCompact(property.activePipelineValue) ??
    formatCurrencyCompact(activeDeals.reduce((sum, deal) => sum + (bestDealValue(deal) ?? 0), 0));

  const kpis: DetailPageShellKpi[] = [
    {
      eyebrow: "Roof area",
      value: property.roofArea == null ? "Unknown" : formatCompactNumber(property.roofArea),
      captionLabel: property.roofArea == null ? "No data" : "Sq ft",
      captionContext:
        property.roofArea == null
          ? "roof area not captured"
          : property.unitCount
            ? `${formatNumber(property.unitCount)} units tracked`
            : "from property profile",
    },
    {
      eyebrow: "Photos on file",
      value:
        property.photosCount != null
          ? String(property.photosCount)
          : property.companycamProjectId || property.companycamId
            ? "Linked"
            : "0",
      captionLabel: property.photosCount != null ? "Count" : property.companycamProjectId || property.companycamId ? "CompanyCam" : "No data",
      captionContext:
        property.photosCount != null
          ? "property photo count"
          : property.companycamProjectId || property.companycamId
            ? "project connected"
            : "no photo source",
    },
    {
      eyebrow: "Active pipeline",
      value: activePipelineValue ?? String(activeDeals.length),
      captionLabel: `${activeDeals.length} ${activeDeals.length === 1 ? "deal" : "deals"}`,
      captionContext: activePipelineValue ? "linked value" : "value unavailable",
      accent: "red",
    },
  ];

  const tabs: DetailPageShellTab[] = PROPERTY_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    count:
      tab.id === "deals"
        ? relatedDeals.length
        : tab.id === "leads"
          ? relatedLeads.length
          : tab.id === "photos" && property.photosCount != null
            ? property.photosCount
            : undefined,
  }));

  return (
    <DetailPageShell
      parentLabel="Properties"
      parentHref="/properties"
      currentLabel={property.name}
      iconSlot={<Building2 className="h-9 w-9" />}
      typeBadge={
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-700">
          {propertyTypeBadge}
        </span>
      }
      statusBadge={
        activeDeals.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-red/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-brand-red ring-1 ring-brand-red/20">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-red" aria-hidden />
            ACTIVE DEAL
          </span>
        ) : undefined
      }
      title={property.name}
      subtitleSlot={
        <>
          {addressLine ? (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-4 w-4" />
              {addressLine}
            </span>
          ) : null}
          {property.companyId ? (
            <Link to={`/companies/${property.companyId}`} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red">
              <Building2 className="h-4 w-4" />
              {property.companyName ?? "View company"}
            </Link>
          ) : (
            <span>Unassigned company</span>
          )}
          {property.buildYear ? <span>Built {property.buildYear}</span> : null}
        </>
      }
      actionsSlot={
        <>
          <Link
            to={`/properties/${property.id}/edit`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <Edit className="h-4 w-4" />
            Edit
          </Link>
          {companyCamUrl ? (
            <a
              href={companyCamUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <Camera className="h-4 w-4" />
              CompanyCam
            </a>
          ) : null}
          <Link
            to={`/deals/new?propertyId=${property.id}${property.companyId ? `&companyId=${property.companyId}` : ""}`}
            className={cn(buttonVariants({ size: "sm" }), "bg-brand-red text-white hover:bg-brand-red/90")}
          >
            <Plus className="h-4 w-4" />
            New deal
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  aria-label="More property actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Copy property link</DropdownMenuItem>
              <DropdownMenuItem>View audit trail</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      kpis={kpis}
      tabs={tabs}
      activeTabId={activeTab}
      onTabChange={(tab) => setActiveTab(tab as PropertyTab)}
      rightRail={
        <PropertyRightRail
          property={property}
          propertyTypeLabel={propertyTypeLabel}
          addressLine={addressLine}
          cityLine={cityLine}
          companyCamUrl={companyCamUrl}
          procorePropertyUrl={procorePropertyUrl}
        />
      }
    >
      <PropertyTabContent
        tab={activeTab}
        property={property}
        leads={relatedLeads}
        deals={relatedDeals}
        propertyTypeLabel={propertyTypeLabel}
        addressLine={addressLine}
        cityLine={cityLine}
        companyCamUrl={companyCamUrl}
      />
    </DetailPageShell>
  );
}

function PropertyRightRail({
  property,
  propertyTypeLabel,
  addressLine,
  cityLine,
  companyCamUrl,
  procorePropertyUrl,
}: {
  property: PropertySurface;
  propertyTypeLabel: string;
  addressLine: string;
  cityLine: string;
  companyCamUrl: string | null;
  procorePropertyUrl: string | null;
}) {
  const coordinates = (() => {
    if (property.lat == null || property.lng == null) return null;
    const lat = typeof property.lat === "number" ? property.lat : Number(property.lat);
    const lng = typeof property.lng === "number" ? property.lng : Number(property.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  })();

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <DetailRailSection title="Owner Company">
          <DetailRailItem
            label="Company"
            value={
              property.companyId ? (
                <Link to={`/companies/${property.companyId}`} className="inline-flex items-center gap-2 text-brand-red hover:underline">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[10px] font-black uppercase text-white">
                    {getInitials(property.companyName ?? "?")}
                  </span>
                  {property.companyName ?? "View company"}
                </Link>
              ) : (
                "No owner company"
              )
            }
          />
        </DetailRailSection>

        <DetailRailSection title="Address">
          <DetailRailItem
            label="Location"
            value={
              addressLine ? (
                <span>
                  <span className="block">{property.address ?? property.name}</span>
                  {cityLine ? <span className="block text-sm font-medium text-slate-600">{cityLine}</span> : null}
                </span>
              ) : (
                "No address on file"
              )
            }
          />
        </DetailRailSection>

        <DetailRailSection title="Type">
          <DetailRailItem label="Property type" value={propertyTypeLabel} />
          <DetailRailItem label="Build year" value={formatNullable(property.buildYear, "Unknown")} />
          <DetailRailItem label="Unit count" value={formatNullable(property.unitCount, "Unknown")} />
          {coordinates ? <DetailRailItem label="Coordinates" value={<span className="font-mono text-xs">{coordinates}</span>} /> : null}
        </DetailRailSection>

        <DetailRailSection title="System IDs">
          <DetailRailItem
            label="HubSpot"
            value={<span className="font-mono text-xs">{formatNullable(property.hubspotPropertyId)}</span>}
          />
          <DetailRailItem
            label="Procore"
            value={
              <span className="space-y-1">
                <span className="block font-mono text-xs">{formatNullable(property.procorePropertyId ?? property.procoreId)}</span>
                {procorePropertyUrl ? (
                  <a
                    href={procorePropertyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
                  >
                    Open in Procore
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            }
          />
          <DetailRailItem
            label="CompanyCam"
            value={
              <span className="space-y-1">
                <span className="block font-mono text-xs">{formatNullable(property.companycamProjectId ?? property.companycamId)}</span>
                {companyCamUrl ? (
                  <a
                    href={companyCamUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
                  >
                    Open in CompanyCam
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            }
          />
        </DetailRailSection>
      </CardContent>
    </Card>
  );
}

function PropertyTabContent({
  tab,
  property,
  leads,
  deals,
  propertyTypeLabel,
  addressLine,
  cityLine,
  companyCamUrl,
}: {
  tab: PropertyTab;
  property: PropertySurface;
  leads: PropertyLead[];
  deals: PropertyDeal[];
  propertyTypeLabel: string;
  addressLine: string;
  cityLine: string;
  companyCamUrl: string | null;
}) {
  if (tab === "overview") {
    return (
      <div className="space-y-6">
        <section>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">About</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-700">
            {property.notes ?? "No property notes have been captured yet."}
          </p>
        </section>

        <section>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Building specs</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <SpecTile label="Roof area" value={property.roofArea == null ? "Unknown" : `${formatNumber(property.roofArea)} sq ft`} />
            <SpecTile label="Build year" value={formatNullable(property.buildYear, "Unknown")} />
            <SpecTile label="Unit count" value={formatNullable(property.unitCount, "Unknown")} />
          </div>
        </section>

        <section>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Location</p>
          <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
            <div className="grid min-h-40 place-items-center bg-slate-50 p-6 text-center">
              <MapPin className="mx-auto h-7 w-7 text-brand-red" />
              <p className="mt-3 text-sm font-black text-slate-950">{addressLine || property.name}</p>
              {cityLine ? <p className="mt-1 text-sm text-slate-600">{cityLine}</p> : null}
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (tab === "deals") {
    return <RelatedDealsList deals={deals} />;
  }

  if (tab === "leads") {
    return <RelatedLeadsList leads={leads} />;
  }

  const placeholders: Record<Exclude<PropertyTab, "overview" | "deals" | "leads">, { title: string; body: string }> = {
    photos: {
      title: "Photo gallery coming soon",
      body: companyCamUrl
        ? "CompanyCam project is linked. Native gallery sync is tracked separately."
        : "No CompanyCam project is linked yet.",
    },
    contacts: {
      title: "Property-linked contacts coming soon",
      body: property.companyName
        ? `Contacts will roll up from ${property.companyName} once property-contact linking ships.`
        : "No owner company is linked for contact rollup.",
    },
    activity: {
      title: "Property activity feed coming soon",
      body: "Activity will aggregate notes, stage movement, photos, files, and linked deal updates.",
    },
    files: {
      title: "Property files coming soon",
      body: "Files currently live on linked deals and leads. Property-level file rollup is tracked separately.",
    },
    companycam: {
      title: "CompanyCam integration",
      body: companyCamUrl ? "CompanyCam project is linked in the right rail." : "No CompanyCam project ID is available.",
    },
  };
  const placeholder = placeholders[tab];

  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6">
      <p className="text-sm font-black text-slate-950">{placeholder.title}</p>
      <p className="mt-2 text-sm text-slate-600">{placeholder.body}</p>
      {tab === "companycam" && companyCamUrl ? (
        <a
          href={companyCamUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
        >
          Open in CompanyCam
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

function SpecTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-black tabular-nums text-slate-950">{value}</p>
    </div>
  );
}

function RelatedDealsList({ deals }: { deals: PropertyDeal[] }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-black text-slate-950">Related deals</p>
        <p className="text-sm text-slate-500">All historical opportunities tied to this property.</p>
      </div>
      {deals.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">No related deals found.</div>
      ) : (
        <div className="space-y-2">
          {deals.map((deal) => (
            <Link
              key={deal.id}
              to={`/deals/${deal.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 transition-colors hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-950">{deal.name}</p>
                <p className="font-mono text-xs text-slate-500">{deal.dealNumber}</p>
              </div>
              <div className="flex items-center gap-2">
                {!deal.isActive ? (
                  <Badge variant="outline" className="bg-slate-50 text-xs text-slate-500">
                    Inactive
                  </Badge>
                ) : null}
                <DealStageBadge stageId={deal.stageId} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function RelatedLeadsList({ leads }: { leads: PropertyLead[] }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-black text-slate-950">Related leads</p>
        <p className="text-sm text-slate-500">Historical pre-RFP opportunities at this property.</p>
      </div>
      {leads.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">No leads at this property yet.</div>
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <Link
              key={lead.id}
              to={`/leads/${lead.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 transition-colors hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-950">{lead.name}</p>
                <p className="font-mono text-xs text-slate-500">{lead.convertedAt ? "Converted" : "Open lead"}</p>
              </div>
              <div className="flex items-center gap-2">
                {!lead.isActive ? (
                  <Badge variant="outline" className="bg-slate-50 text-xs text-slate-500">
                    Inactive
                  </Badge>
                ) : null}
                <LeadStageBadge stageId={lead.stageId} converted={lead.status === "converted"} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
