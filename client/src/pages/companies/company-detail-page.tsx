import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  MapPin,
  Phone,
  Globe,
  Users,
  Handshake,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCompanyDetail, useCompanyContacts, useCompanyDeals } from "@/hooks/use-companies";
import { formatPhone } from "@/lib/contact-utils";
import { ContactForm } from "@/components/contacts/contact-form";

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

type Tab = "contacts" | "deals";

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { company, loading, error, refetch: refetchCompany } = useCompanyDetail(id);
  const [activeTab, setActiveTab] = useState<Tab>("contacts");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactsKey, setContactsKey] = useState(0);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
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

  const colorClass =
    company.category
      ? COMPANY_CATEGORY_COLORS[company.category] ?? "bg-gray-100 text-gray-800"
      : null;
  const categoryLabel =
    company.category
      ? COMPANY_CATEGORY_LABELS[company.category] ?? company.category
      : null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "contacts", label: "Contacts" },
    { key: "deals", label: "Deals" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1 -ml-2"
            onClick={() => navigate("/companies")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Companies
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{company.name}</h2>
            {categoryLabel && colorClass && (
              <Badge variant="outline" className={`${colorClass} border-0 text-xs`}>
                {categoryLabel}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => setAddContactOpen(true)}
          >
            <UserPlus className="h-4 w-4 mr-2" />
            Add Contact
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/companies/${company.id}/edit`)}
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Company Information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {company.phone && (
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span>{formatPhone(company.phone)}</span>
            </div>
          )}
          {company.website && (
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <a
                href={
                  company.website.startsWith("http")
                    ? company.website
                    : `https://${company.website}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline truncate"
              >
                {company.website}
              </a>
            </div>
          )}
          {(company.city || company.state || company.address) && (
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>
                {company.address && `${company.address}, `}
                {[company.city, company.state].filter(Boolean).join(", ")}
                {company.zip && ` ${company.zip}`}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span>{company.contactCount} contact{company.contactCount !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex items-center gap-2">
            <Handshake className="h-4 w-4 text-muted-foreground" />
            <span>{company.dealCount} deal{company.dealCount !== 1 ? "s" : ""}</span>
          </div>
        </CardContent>
      </Card>

      {/* Notes */}
      {company.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{company.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-brand-red text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "contacts" && <CompanyContactsTab key={contactsKey} companyId={company.id} onAddContact={() => setAddContactOpen(true)} />}
      {activeTab === "deals" && <CompanyDealsTab companyId={company.id} />}

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

function CompanyContactsTab({ companyId, onAddContact }: { companyId: string; onAddContact?: () => void }) {
  const navigate = useNavigate();
  const { contacts, loading, error } = useCompanyContacts(companyId);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (contacts.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No contacts linked to this company.</p>
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
      {contacts.map((contact) => (
        <Card
          key={contact.id}
          className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => navigate(`/contacts/${contact.id}`)}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">
                {contact.firstName} {contact.lastName}
              </p>
              {contact.jobTitle && (
                <p className="text-xs text-muted-foreground">{contact.jobTitle}</p>
              )}
            </div>
            {contact.email && (
              <p className="text-xs text-muted-foreground">{contact.email}</p>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function CompanyDealsTab({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const { deals, loading, error } = useCompanyDeals(companyId);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (deals.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Handshake className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No deals linked to this company.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {deals.map((deal) => (
        <Card
          key={deal.id}
          className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => navigate(`/deals/${deal.id}`)}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{deal.name}</p>
              <p className="text-xs text-muted-foreground">#{deal.dealNumber}</p>
            </div>
            {!deal.isActive && (
              <Badge variant="outline" className="text-xs bg-gray-100 text-gray-600 border-0">
                Inactive
              </Badge>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
