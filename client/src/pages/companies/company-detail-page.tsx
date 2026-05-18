import { useState, useEffect, useCallback, useMemo } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Edit,
  Download,
  ExternalLink,
  Hash,
  MapPin,
  Globe,
  Users,
  Handshake,
  UserPlus,
  Mail,
  FileText,
  Building2,
  Plus,
  MoreHorizontal,
  Mic,
  Activity as ActivityIcon,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useCompanyDetail, useCompanyContacts, useCompanyDeals, verifyCompany, type Company } from "@/hooks/use-companies";
import { useLeads } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { ContactForm } from "@/components/contacts/contact-form";
import { PropertyCreateDialog } from "@/components/properties/property-create-dialog";
import { CompanyCopilotPanel } from "@/components/ai/company-copilot-panel";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { EntityActivityTab } from "@/components/activities/entity-activity-tab";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatPropertyLabel, useProperties } from "@/hooks/use-properties";
import type { Activity } from "@/hooks/use-activities";
import { CRM_OWNED_LEAD_STAGE_SLUGS } from "@trock-crm/shared/types";

// --- Constants ---

const COMPANY_CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property Manager",
  vendor: "Vendor",
  consultant: "Consultant",
  other: "Other",
};
const HUBSPOT_PORTAL_ID: string | null = null;

// --- Utility Functions ---

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "bg-red-600", "bg-blue-600", "bg-green-600", "bg-purple-600",
    "bg-amber-600", "bg-teal-600", "bg-indigo-600", "bg-pink-600",
    "bg-cyan-600", "bg-orange-600",
  ];
  return colors[Math.abs(hash) % colors.length];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatNullable(value: string | number | null | undefined, fallback = "Not set") {
  if (value == null || value === "") return fallback;
  return String(value);
}

function formatIndustryLabel(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatCurrencyCompact(value: string | number | null | undefined) {
  if (value == null || value === "") return "Unknown";
  const amount = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount)) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: amount >= 1_000_000 ? 1 : 0,
  }).format(amount);
}

function formatCount(value: number | null | undefined) {
  if (value == null) return "Unknown";
  return String(value);
}

function companyLocation(company: { city: string | null; state: string | null; address: string | null; zip: string | null }) {
  const cityState = [company.city, company.state].filter(Boolean).join(", ");
  return [company.address, cityState, company.zip].filter(Boolean).join(" ");
}

function extractDomain(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = value.startsWith("http") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || null;
  }
}

function buildCompanyWebsiteUrl(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith("http") ? value : `https://${value}`;
}

function buildHubSpotCompanyUrl(hubspotCompanyId: string | null | undefined) {
  if (!hubspotCompanyId || !HUBSPOT_PORTAL_ID) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/company/${encodeURIComponent(hubspotCompanyId)}`;
}

function exportCompanyCSV(
  company: { name: string; category: string | null; phone: string | null; website: string | null; city: string | null; state: string | null; address: string | null; zip: string | null; notes: string | null },
  contacts: Array<{ firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string | null }>
) {
  const rows: string[][] = [
    ["Company Name", "Category", "Phone", "Website", "Address", "City", "State", "Zip", "Notes"],
    [
      company.name,
      company.category ?? "",
      company.phone ?? "",
      company.website ?? "",
      company.address ?? "",
      company.city ?? "",
      company.state ?? "",
      company.zip ?? "",
      (company.notes ?? "").replace(/"/g, '""'),
    ],
    [],
    ["Contact Name", "Job Title", "Email", "Phone"],
    ...contacts.map((c) => [
      `${c.firstName} ${c.lastName}`,
      c.jobTitle ?? "",
      c.email ?? "",
      c.phone ?? "",
    ]),
  ];

  const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${company.name.replace(/[^a-zA-Z0-9]/g, "_")}_export.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Types ---

type Tab = "overview" | "contacts" | "portfolio" | "deals" | "files" | "emails" | "activity" | "recordings";

// --- Main Component ---

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { company, loading, error, refetch: refetchCompany } = useCompanyDetail(id);
  const { contacts: allContacts } = useCompanyContacts(id);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactsKey, setContactsKey] = useState(0);
  const [portfolioKey, setPortfolioKey] = useState(0);
  const [verifyingCompany, setVerifyingCompany] = useState(false);

  if (loading) {
    return (
      <div className="space-y-6 p-4">
        <div className="h-10 w-64 bg-muted animate-pulse rounded" />
        <div className="h-48 bg-muted animate-pulse rounded-xl" />
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-4 h-64 bg-muted animate-pulse rounded-xl" />
          <div className="col-span-8 h-64 bg-muted animate-pulse rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !company) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Company not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/companies")}>
          Back to Companies
        </Button>
      </div>
    );
  }

  const categoryLabel = company.category ? COMPANY_CATEGORY_LABELS[company.category] ?? company.category : null;
  const industryLabel = formatIndustryLabel(company.industry) ?? categoryLabel ?? "Company";
  const location = companyLocation(company);
  const websiteRaw = company.website?.trim() || company.domain?.trim() || null;
  const domain = company.domain?.trim() || extractDomain(websiteRaw);
  const hubspotCompanyId = company.hubspotCompanyId ?? company.hubspotId ?? null;
  const hubspotUrl = buildHubSpotCompanyUrl(hubspotCompanyId);
  const websiteUrl = buildCompanyWebsiteUrl(websiteRaw);
  const propertyCount = company.propertiesCount;
  const contactCount = company.contactsCount ?? company.contactCount;
  const dealCount = company.activeDealsCount ?? company.dealCount;
  const pipelineKpiValue =
    company.pipelineValue == null || company.pipelineValue === ""
      ? dealCount == null
        ? "Unknown"
        : String(dealCount)
      : formatCurrencyCompact(company.pipelineValue);

  const handleVerifyCompany = async () => {
    setVerifyingCompany(true);
    try {
      await verifyCompany(company.id);
      await refetchCompany();
    } finally {
      setVerifyingCompany(false);
    }
  };

  const handleDeleteCompany = async () => {
    if (!window.confirm("Are you sure you want to delete this company? This action can be undone by an admin.")) return;
    try {
      await api(`/companies/${company.id}`, { method: "DELETE" });
      navigate("/companies");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete company");
    }
  };

  const tabs: DetailPageShellTab[] = [
    { id: "overview", label: "Overview", icon: <FileText className="h-4 w-4" /> },
    { id: "contacts", label: "Contacts", icon: <Users className="h-4 w-4" />, count: contactCount },
    { id: "portfolio", label: "Portfolio", icon: <Building2 className="h-4 w-4" />, count: propertyCount },
    { id: "deals", label: "Deals", icon: <Handshake className="h-4 w-4" />, count: dealCount },
    { id: "files", label: "Files", icon: <FileText className="h-4 w-4" /> },
    { id: "emails", label: "Emails", icon: <Mail className="h-4 w-4" /> },
    { id: "activity", label: "Activity", icon: <ActivityIcon className="h-4 w-4" /> },
    { id: "recordings", label: "Recordings", icon: <Mic className="h-4 w-4" /> },
  ];

  const kpis: DetailPageShellKpi[] = [
    {
      eyebrow: "Active pipeline",
      value: pipelineKpiValue,
      captionLabel: dealCount == null ? "No data" : `${dealCount} deals`,
      captionContext: company.pipelineValue == null || company.pipelineValue === "" ? "No tracked value" : "open value",
    },
    {
      eyebrow: "Properties",
      value: formatCount(propertyCount),
      captionLabel: propertyCount == null ? "No data" : "In portfolio",
      captionContext: "linked properties",
    },
    {
      eyebrow: "Contacts",
      value: formatCount(contactCount),
      captionLabel: contactCount == null ? "No data" : "Decision makers",
      captionContext: "across roles",
      accent: "red",
    },
  ];

  const typeBadge = (
    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-700">
      {industryLabel}
    </span>
  );

  const statusBadge = company.companyVerificationStatus === "verified" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
      <CheckCircle2 className="h-3 w-3" />
      Verified
    </span>
  ) : company.companyVerificationStatus === "pending" ? (
    <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">
      Pending verification
    </span>
  ) : null;

  const subtitleSlot = (
    <>
      {location ? (
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-4 w-4" />
          {location}
        </span>
      ) : null}
      {domain ? (
        <span className="inline-flex items-center gap-1">
          <Globe className="h-4 w-4" />
          {domain}
        </span>
      ) : null}
      {hubspotCompanyId ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500">
          <Hash className="h-3.5 w-3.5" />
          {hubspotCompanyId}
        </span>
      ) : null}
      <span>
        {company.companyVerificationStatus === "verified"
          ? `Verified${company.companyVerifiedAt ? ` ${formatDate(company.companyVerifiedAt)}` : ""}`
          : company.companyVerificationStatus === "pending"
            ? "Verification pending"
            : "Verification not set"}
      </span>
    </>
  );

  const actionsSlot = (
    <>
      <Link to={`/companies/${company.id}/edit`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        <Edit className="h-4 w-4" />
        Edit
      </Link>
      {hubspotUrl ? (
        <a href={hubspotUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <ExternalLink className="h-4 w-4" />
          HubSpot
        </a>
      ) : null}
      <Link
        to={`/deals/new?companyId=${encodeURIComponent(company.id)}`}
        className={cn(buttonVariants({ size: "sm" }), "bg-brand-red text-white hover:bg-brand-red/90")}
      >
        <Plus className="h-4 w-4" />
        New deal
      </Link>
      <PropertyCreateDialog
        initialCompanyId={company.id}
        companyLocked
        triggerLabel="Add Property"
        onCreated={() => {
          refetchCompany();
          setPortfolioKey((key) => key + 1);
          setActiveTab("portfolio");
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setAddContactOpen(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add Contact
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => exportCompanyCSV(company, allContacts)}>
            <Download className="h-4 w-4 mr-2" />
            Export Data
          </DropdownMenuItem>
          {company.companyVerificationStatus === "pending" ? (
            <DropdownMenuItem onClick={handleVerifyCompany} disabled={verifyingCompany}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {verifyingCompany ? "Verifying..." : "Verify Company"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={handleDeleteCompany} className="text-red-600">
            Delete Company
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const tabContent = (
    <div className="space-y-4">
      {activeTab === "overview" && (
        <div className="space-y-4">
          <CompanyCopilotPanel companyId={company.id} />
          <div className="rounded-lg border bg-slate-50/50 p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">About</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">
              {company.notes ?? "No company notes recorded yet."}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-white p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Location</p>
              <p className="mt-2 text-sm font-semibold text-slate-950">{location || "Not set"}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Created</p>
              <p className="mt-2 text-sm font-semibold text-slate-950">{formatDate(company.createdAt)}</p>
            </div>
          </div>
        </div>
      )}
      {activeTab === "contacts" && (
        <CompanyContactsTab key={contactsKey} companyId={company.id} onAddContact={() => setAddContactOpen(true)} />
      )}
      {activeTab === "portfolio" && <CompanyPortfolioTab key={portfolioKey} companyId={company.id} companyName={company.name} />}
      {activeTab === "deals" && <CompanyDealsTab companyId={company.id} />}
      {activeTab === "files" && <CompanyFilesTab companyId={company.id} />}
      {activeTab === "emails" && <CompanyEmailsTab />}
      {activeTab === "activity" && <EntityActivityTab entityType="company" entityId={company.id} emptyLabel="company" />}
      {activeTab === "recordings" && <RecordingList entityType="company" entityId={company.id} />}
    </div>
  );

  const rightRail = (
    <CompanyRightRail
      company={company}
      categoryLabel={categoryLabel}
      industryLabel={industryLabel}
      domain={domain}
      websiteUrl={websiteUrl}
      hubspotCompanyId={hubspotCompanyId}
      hubspotUrl={hubspotUrl}
    />
  );

  return (
    <div>
      <DetailPageShell
        parentLabel="Companies"
        parentHref="/companies"
        currentLabel={company.name}
        iconSlot={<Building2 className="h-9 w-9" />}
        typeBadge={typeBadge}
        statusBadge={statusBadge}
        title={company.name}
        subtitleSlot={subtitleSlot}
        actionsSlot={actionsSlot}
        kpis={kpis}
        tabs={tabs}
        activeTabId={activeTab}
        onTabChange={(tab) => setActiveTab(tab as Tab)}
        rightRail={rightRail}
      >
        {tabContent}
      </DetailPageShell>

      {/* Add Contact Dialog */}
      <Dialog open={addContactOpen} onOpenChange={setAddContactOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Contact to {company.name}</DialogTitle>
          </DialogHeader>
          <ContactForm
            defaults={{
              companyId: company.id,
              companyName: company.name,
              category: company.category ?? "client",
            }}
            onSuccess={() => {
              setAddContactOpen(false);
              refetchCompany();
              setContactsKey((k) => k + 1);
              setActiveTab("contacts");
            }}
            onCancel={() => setAddContactOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CompanyRightRail({
  company,
  categoryLabel,
  industryLabel,
  domain,
  websiteUrl,
  hubspotCompanyId,
  hubspotUrl,
}: {
  company: Company;
  categoryLabel: string | null;
  industryLabel: string;
  domain: string | null;
  websiteUrl: string | null;
  hubspotCompanyId: string | null;
  hubspotUrl: string | null;
}) {
  const ownerValue =
    company.ownerUserName ??
    (company.ownerUserId ? `Owner ID: ${company.ownerUserId}` : "Unassigned");
  const ownerInitials = getInitials(ownerValue === "Unassigned" ? "Unassigned" : ownerValue);
  const verificationValue = company.companyVerificationStatus === "verified"
    ? `${company.companyVerifiedAt ? formatDate(company.companyVerifiedAt) : "Verified"}${company.companyVerifiedBy ? ` by ${company.companyVerifiedBy}` : ""}`
    : company.companyVerificationStatus === "pending"
      ? "Pending"
      : "Not verified";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <DetailRailSection title="Owner">
            <DetailRailItem
              label="Account owner"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[10px] font-black uppercase text-white">
                    {ownerInitials}
                  </span>
                  {ownerValue}
                </span>
              }
            />
          </DetailRailSection>

          <DetailRailSection title="Industry">
            <DetailRailItem label={company.industry ? "Industry" : "Category"} value={industryLabel} />
            {categoryLabel && company.industry ? <DetailRailItem label="Category" value={categoryLabel} /> : null}
          </DetailRailSection>

          <DetailRailSection title="Region">
            <DetailRailItem label="Market" value={formatNullable(company.region)} />
          </DetailRailSection>

          <DetailRailSection title="Domain">
            <DetailRailItem
              label={company.domain ? "Domain" : "Website domain"}
              value={
                domain && websiteUrl ? (
                  <a href={websiteUrl} target="_blank" rel="noreferrer" className="text-brand-red hover:underline">
                    {domain}
                  </a>
                ) : (
                  "Not set"
                )
              }
            />
          </DetailRailSection>

          <DetailRailSection title="Verification">
            <DetailRailItem label="Status" value={verificationValue} />
          </DetailRailSection>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <DetailRailSection title="System IDs">
            <DetailRailItem
              label="HubSpot"
              value={
                <span className="space-y-1">
                  <span className="block font-mono text-xs">{formatNullable(hubspotCompanyId, "Not linked")}</span>
                  {hubspotUrl ? (
                    <a
                      href={hubspotUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
                    >
                      Open in HubSpot
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </span>
              }
            />
            <DetailRailItem label="Procore" value={<span className="font-mono text-xs">{formatNullable(company.procoreId, "Not linked")}</span>} />
          </DetailRailSection>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Contacts Tab ---

function CompanyContactsTab({
  companyId,
  onAddContact,
}: {
  companyId: string;
  onAddContact?: () => void;
}) {
  const navigate = useNavigate();
  const { contacts, loading, error } = useCompanyContacts(companyId);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (contacts.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Users className="h-10 w-10 mx-auto mb-3 opacity-20" />
        <p className="text-sm mb-1">No contacts linked to this company.</p>
        {onAddContact && (
          <Button variant="outline" size="sm" className="mt-3" onClick={onAddContact}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add First Contact
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {contacts.map((contact, idx) => {
        const fullName = `${contact.firstName} ${contact.lastName}`;
        const initials = getInitials(fullName);
        const avatarColor = hashColor(fullName);
        const isKeyContact = idx === 0;

        return (
          <div
            key={contact.id}
            className="flex items-center gap-4 px-4 py-3 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 cursor-pointer transition-colors"
            onClick={() => navigate(`/contacts/${contact.id}`)}
          >
            {/* Avatar */}
            <div
              className={`flex-shrink-0 w-10 h-10 rounded-full ${avatarColor} flex items-center justify-center`}
            >
              <span className="text-sm font-bold text-white">{initials}</span>
            </div>

            {/* Name + title */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">{fullName}</p>
              {contact.jobTitle && (
                <p className="text-[11px] uppercase tracking-wider text-zinc-400 font-medium">
                  {contact.jobTitle}
                </p>
              )}
            </div>

            {/* Email */}
            {contact.email && (
              <p className="text-xs text-muted-foreground hidden sm:block truncate max-w-[200px]">
                {contact.email}
              </p>
            )}

            {/* Role indicator dot */}
            <div
              className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${
                isKeyContact ? "bg-[#CC0000]" : "bg-zinc-300"
              }`}
              title={isKeyContact ? "Key contact" : "Standard"}
            />
          </div>
        );
      })}

      {/* Add contact button */}
      {onAddContact && (
        <button
          onClick={onAddContact}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-zinc-300 text-zinc-400 hover:border-zinc-400 hover:text-zinc-500 transition-colors"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">Add Associated Contact</span>
        </button>
      )}
    </div>
  );
}

// --- Deals Tab ---

function CompanyDealsTab({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const { deals, loading, error } = useCompanyDeals(companyId);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (deals.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Handshake className="h-10 w-10 mx-auto mb-3 opacity-20" />
        <p className="text-sm">No deals linked to this company.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {deals.map((deal) => (
        <div
          key={deal.id}
          className="flex items-center gap-4 px-4 py-3 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 cursor-pointer transition-colors"
          onClick={() => navigate(`/deals/${deal.id}`)}
        >
          {/* Deal number badge */}
          <Badge
            variant="outline"
            className="bg-zinc-100 text-zinc-600 border-zinc-200 font-mono text-xs flex-shrink-0"
          >
            #{deal.dealNumber}
          </Badge>

          {/* Deal name */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{deal.name}</p>
          </div>

          {/* Stage pill */}
          <DealStageBadge stageId={deal.stageId} className="flex-shrink-0" />

          {/* Active status */}
          {!deal.isActive && (
            <Badge
              variant="outline"
              className="bg-zinc-100 text-zinc-500 border-zinc-200 text-xs flex-shrink-0"
            >
              Inactive
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Files Tab ---

interface CompanyFile {
  id: string;
  originalName: string;
  category: string;
  createdAt: string;
  dealId: string;
}

function CompanyFilesTab({ companyId }: { companyId: string }) {
  const { deals } = useCompanyDeals(companyId);
  const [files, setFiles] = useState<CompanyFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (deals.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(
      deals.map((deal) =>
        api<{ files: CompanyFile[] }>(`/files?dealId=${deal.id}`)
          .then((data) => data.files.map((f) => ({ ...f, dealId: deal.id })))
          .catch(() => [] as CompanyFile[])
      )
    )
      .then((results) => {
        if (!cancelled) {
          setFiles(results.flat());
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load files");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deals]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="h-10 w-10 mx-auto mb-3 opacity-20" />
        <p className="text-sm">No files found across associated deals.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <div
          key={file.id}
          className="flex items-center gap-4 px-4 py-3 rounded-lg border border-zinc-200 bg-white"
        >
          <FileText className="h-5 w-5 text-zinc-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{file.originalName}</p>
            <p className="text-[11px] text-zinc-400">
              {file.category} &middot; {formatDate(file.createdAt)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Emails Tab ---

function CompanyEmailsTab() {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <Mail className="h-10 w-10 mx-auto mb-3 opacity-20" />
      <p className="text-sm font-medium mb-1">Email integration coming soon</p>
      <p className="text-xs text-zinc-400">
        Emails associated with this company's contacts and deals will appear here.
      </p>
    </div>
  );
}

function CompanyPortfolioTab({ companyId, companyName }: { companyId: string; companyName: string }) {
  const { deals } = useCompanyDeals(companyId);
  const { leads } = useLeads({ companyId, isActive: "all" });
  const { properties } = useProperties({ companyId, limit: 500 });
  const { stages } = usePipelineStages();
  const leadDetailStageIds = useMemo(
    () =>
      new Set(
        stages
          .filter(
            (stage) =>
              CRM_OWNED_LEAD_STAGE_SLUGS.includes(
                stage.slug as (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number]
              ) && stage.slug !== "opportunity"
          )
          .map((stage) => stage.id)
      ),
    [stages]
  );
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setActivitiesLoading(true);

    Promise.all(
      deals.map((deal) =>
        api<{ activities: Activity[] }>(`/activities?dealId=${deal.id}&limit=50`)
          .then((data) => data.activities.map((activity) => ({ ...activity, dealId: deal.id })))
          .catch(() => [] as Activity[])
      )
    )
      .then((results) => {
        if (!cancelled) {
          setActivities(results.flat().sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()));
        }
      })
      .finally(() => {
        if (!cancelled) setActivitiesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deals]);

  const leadDeals = leads;

  const activitySummary = useMemo(() => {
    const counts = { total: activities.length, call: 0, email: 0, meeting: 0, note: 0 };
    for (const activity of activities) {
      if (activity.type in counts) {
        counts[activity.type as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [activities]);

  return (
    <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Properties</p>
          <p className="mt-2 text-2xl font-black">{properties.length}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Leads</p>
          <p className="mt-2 text-2xl font-black">{leadDeals.length}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Deals</p>
          <p className="mt-2 text-2xl font-black">{deals.length}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Activities</p>
          <p className="mt-2 text-2xl font-black">{activitySummary.total}</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold">Related Properties</p>
                <p className="text-sm text-muted-foreground">First-class property records attached to this company.</p>
          </div>
          <div className="space-y-2">
            {properties.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No related properties found.
              </div>
            ) : (
              properties.map((property) => (
                <Link key={property.id} to={`/properties/${property.id}`} className="block rounded-lg border bg-white p-3 transition-colors hover:bg-zinc-50">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{formatPropertyLabel(property)}</p>
                      <p className="text-xs text-muted-foreground">{property.companyName ?? companyName}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{property.dealCount} deals</p>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold">Activity Rollup</p>
            <p className="text-sm text-muted-foreground">Deal-linked activity summarized across the company portfolio.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border bg-white p-3">
              <p className="text-muted-foreground">Calls</p>
              <p className="text-xl font-black">{activitySummary.call}</p>
            </div>
            <div className="rounded-lg border bg-white p-3">
              <p className="text-muted-foreground">Emails</p>
              <p className="text-xl font-black">{activitySummary.email}</p>
            </div>
            <div className="rounded-lg border bg-white p-3">
              <p className="text-muted-foreground">Meetings</p>
              <p className="text-xl font-black">{activitySummary.meeting}</p>
            </div>
            <div className="rounded-lg border bg-white p-3">
              <p className="text-muted-foreground">Notes</p>
              <p className="text-xl font-black">{activitySummary.note}</p>
            </div>
          </div>

          <div className="space-y-2">
            {activitiesLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-16 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : activities.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No activity recorded yet.
              </div>
            ) : (
              activities.slice(0, 5).map((activity) => (
                <div key={activity.id} className="rounded-lg border bg-white p-3">
                  <p className="text-sm font-medium capitalize">{activity.type.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {activity.subject ?? activity.body ?? "Activity"} · {new Date(activity.occurredAt).toLocaleDateString()}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">Related Deals</p>
          <p className="text-sm text-muted-foreground">Leads and downstream deals tied to this company.</p>
        </div>
        <div className="space-y-2">
          {deals.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No related deals found.
            </div>
          ) : (
            deals.map((deal) => {
              const opensLeadDetail =
                Boolean(deal.sourceLeadId) && leadDetailStageIds.has(deal.stageId);

              return (
                <Link
                  key={deal.id}
                  to={opensLeadDetail ? `/leads/${deal.sourceLeadId ?? deal.id}` : `/deals/${deal.id}`}
                  className="block rounded-lg border bg-white p-3 transition-colors hover:bg-zinc-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{deal.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{deal.dealNumber}</p>
                    </div>
                    {opensLeadDetail ? (
                      <LeadStageBadge stageId={deal.stageId} />
                    ) : (
                      <DealStageBadge stageId={deal.stageId} />
                    )}
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
