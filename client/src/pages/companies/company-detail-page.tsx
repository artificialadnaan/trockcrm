import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Download,
  MapPin,
  Phone,
  Globe,
  Users,
  Handshake,
  UserPlus,
  Mail,
  FileText,
  Calendar,
  Building2,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { useCompanyDetail, useCompanyContacts, useCompanyDeals } from "@/hooks/use-companies";
import { formatPhone } from "@/lib/contact-utils";
import { ContactForm } from "@/components/contacts/contact-form";
import { CompanyCopilotPanel } from "@/components/ai/company-copilot-panel";
import { api } from "@/lib/api";

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

const COMPANY_CATEGORY_COLORS: Record<string, string> = {
  client: "bg-blue-100 text-blue-800",
  subcontractor: "bg-orange-100 text-orange-800",
  architect: "bg-red-100 text-red-800",
  property_manager: "bg-green-100 text-green-800",
  vendor: "bg-yellow-100 text-yellow-800",
  consultant: "bg-indigo-100 text-indigo-800",
  other: "bg-gray-100 text-gray-800",
};

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

type Tab = "contacts" | "deals" | "files" | "emails";

// --- Main Component ---

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { company, loading, error, refetch: refetchCompany } = useCompanyDetail(id);
  const { contacts: allContacts } = useCompanyContacts(id);
  const [activeTab, setActiveTab] = useState<Tab>("contacts");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactsKey, setContactsKey] = useState(0);

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

  const categoryLabel =
    company.category
      ? COMPANY_CATEGORY_LABELS[company.category] ?? company.category
      : null;
  const categoryColor =
    company.category
      ? COMPANY_CATEGORY_COLORS[company.category] ?? "bg-gray-100 text-gray-800"
      : null;

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "contacts", label: "Contacts", icon: <Users className="h-4 w-4" /> },
    { key: "deals", label: "Deals", icon: <Handshake className="h-4 w-4" /> },
    { key: "files", label: "Files", icon: <FileText className="h-4 w-4" /> },
    { key: "emails", label: "Emails", icon: <Mail className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/companies")}
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Companies
      </Button>

      {/* Hero Header */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Left side: company identity */}
        <div className="flex-1 min-w-0">
          {/* Active Portfolio label */}
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#CC0000] opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#CC0000]" />
            </span>
            <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-[#CC0000]">
              Active Portfolio
            </span>
          </div>

          {/* Company name */}
          <h1 className="text-4xl lg:text-5xl font-black tracking-tighter text-foreground leading-none mb-2">
            {company.name}
          </h1>

          {/* Description / notes */}
          {company.notes && (
            <p className="text-lg font-light text-muted-foreground max-w-xl mb-4 line-clamp-2">
              {company.notes}
            </p>
          )}

          {/* Category badge */}
          {categoryLabel && categoryColor && (
            <Badge variant="outline" className={`${categoryColor} border-0 text-xs font-semibold mb-5`}>
              {categoryLabel}
            </Badge>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 mt-2">
            <Button
              size="sm"
              className="bg-gradient-to-r from-[#CC0000] to-[#991B1B] hover:from-[#B91C1C] hover:to-[#7F1D1D] text-white shadow-md"
              onClick={() => navigate(`/companies/${company.id}/edit`)}
            >
              <Edit className="h-4 w-4 mr-2" />
              Edit Profile
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-zinc-300 text-zinc-600 hover:bg-zinc-100"
              onClick={() => exportCompanyCSV(company, allContacts)}
            >
              <Download className="h-4 w-4 mr-2" />
              Export Data
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-zinc-300 text-zinc-600 hover:bg-zinc-100"
              onClick={() => setAddContactOpen(true)}
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Add Contact
            </Button>
          </div>
        </div>

        {/* Right side: Bento stats grid */}
        <div className="grid grid-cols-2 gap-4 w-full lg:w-auto lg:min-w-[360px]">
          {/* Card 1: Contacts */}
          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm relative overflow-hidden">
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-[#CC0000]" />
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-zinc-400" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Associated Contacts
              </span>
            </div>
            <p className="text-4xl font-black text-foreground">{company.contactCount}</p>
          </div>

          {/* Card 2: Deals */}
          <div className="bg-white rounded-xl border border-zinc-200 p-5 shadow-sm relative overflow-hidden">
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-400" />
            <div className="flex items-center gap-2 mb-2">
              <Handshake className="h-4 w-4 text-zinc-400" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Active Pipeline
              </span>
            </div>
            <p className="text-4xl font-black text-foreground">{company.dealCount}</p>
          </div>
        </div>
      </div>

      {/* Main Content: 12-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left column: Organization Architecture */}
        <div className="lg:col-span-4">
          <div className="bg-zinc-50 rounded-xl border border-zinc-200 p-6">
            <div className="flex items-center gap-2 mb-5">
              <Building2 className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500">
                Organization Architecture
              </h3>
            </div>

            <div className="space-y-4">
              {/* Category */}
              {categoryLabel && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Category</p>
                  <p className="text-sm font-medium text-foreground">{categoryLabel}</p>
                </div>
              )}

              {/* Location */}
              {(company.address || company.city || company.state || company.zip) && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Location</p>
                  <div className="flex items-start gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-zinc-400 mt-0.5 shrink-0" />
                    <div className="text-sm font-medium text-foreground">
                      {company.address && (
                        <p>{company.address}</p>
                      )}
                      <p>
                        {[
                          [company.city, company.state].filter(Boolean).join(", "),
                          company.zip,
                        ].filter(Boolean).join(" ")}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Phone */}
              {company.phone && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Phone</p>
                  <div className="flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-zinc-400" />
                    <p className="text-sm font-medium text-foreground">{formatPhone(company.phone)}</p>
                  </div>
                </div>
              )}

              {/* Website */}
              {company.website && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Website</p>
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-zinc-400" />
                    <a
                      href={
                        company.website.startsWith("http")
                          ? company.website
                          : `https://${company.website}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-[#CC0000] hover:underline truncate"
                    >
                      {company.website}
                    </a>
                  </div>
                </div>
              )}

              {/* Created */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Created</p>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-zinc-400" />
                  <p className="text-sm font-medium text-foreground">{formatDate(company.createdAt)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: Tabbed content */}
        <div className="lg:col-span-8">
          <div className="mb-4">
            <CompanyCopilotPanel companyId={company.id} />
          </div>

          {/* Tab bar */}
          <div className="border-b border-zinc-200 mb-4">
            <div className="flex gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? "border-[#CC0000] text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300"
                  }`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          {activeTab === "contacts" && (
            <CompanyContactsTab
              key={contactsKey}
              companyId={company.id}
              onAddContact={() => setAddContactOpen(true)}
            />
          )}
          {activeTab === "deals" && <CompanyDealsTab companyId={company.id} />}
          {activeTab === "files" && <CompanyFilesTab companyId={company.id} />}
          {activeTab === "emails" && <CompanyEmailsTab />}
        </div>
      </div>

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
