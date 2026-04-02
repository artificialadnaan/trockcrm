import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Trash2,
  MoreHorizontal,
  Building2,
  MapPin,
  Phone,
  Mail,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContactCategoryBadge } from "@/components/contacts/contact-category-badge";
import { ContactTouchpointCard } from "@/components/contacts/contact-touchpoint-card";
import { ContactDealsTab } from "@/components/contacts/contact-deals-tab";
import { ContactActivityTab } from "@/components/contacts/contact-activity-tab";
import { ContactEmailTab } from "@/components/email/contact-email-tab";
import { useContactDetail, deleteContact as apiDeleteContact } from "@/hooks/use-contacts";
import { useAuth } from "@/lib/auth";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";

type Tab = "deals" | "email" | "activity" | "files";

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { contact, loading, error } = useContactDetail(id);
  const [activeTab, setActiveTab] = useState<Tab>("deals");

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Contact not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/contacts")}>
          Back to Contacts
        </Button>
      </div>
    );
  }

  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this contact?")) return;
    try {
      await apiDeleteContact(contact.id);
      navigate("/contacts");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete contact");
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "deals", label: "Deals" },
    { key: "email", label: "Email" },
    { key: "activity", label: "Activity" },
    { key: "files", label: "Files" },
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
            onClick={() => navigate("/contacts")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Contacts
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{fullName(contact)}</h2>
            <ContactCategoryBadge category={contact.category} />
          </div>
          {contact.jobTitle && (
            <p className="text-muted-foreground mt-0.5">{contact.jobTitle}</p>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>}
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => navigate(`/contacts/${contact.id}/edit`)}>
              <Edit className="h-4 w-4 mr-2" />
              Edit Contact
            </DropdownMenuItem>
            {isDirectorOrAdmin && (
              <DropdownMenuItem onClick={handleDelete} className="text-red-600">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Contact
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Contact Info */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {contact.email && (
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <a href={`mailto:${contact.email}`} className="text-blue-600 hover:underline">
                  {contact.email}
                </a>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{formatPhone(contact.phone)}</span>
              </div>
            )}
            {contact.mobile && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{formatPhone(contact.mobile)} (mobile)</span>
              </div>
            )}
            {contact.companyName && (
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span>{contact.companyName}</span>
              </div>
            )}
            {contact.jobTitle && (
              <div className="flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-muted-foreground" />
                <span>{contact.jobTitle}</span>
              </div>
            )}
            {contactLocation(contact) && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>
                  {contact.address && `${contact.address}, `}
                  {contactLocation(contact)}
                  {contact.zip && ` ${contact.zip}`}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Touchpoints */}
        <ContactTouchpointCard contact={contact} />
      </div>

      {/* Notes */}
      {contact.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
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
                  ? "border-brand-purple text-foreground"
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
      {activeTab === "deals" && <ContactDealsTab contactId={contact.id} />}
      {activeTab === "email" && (
        <ContactEmailTab contactId={contact.id} contactEmail={contact.email} />
      )}
      {activeTab === "activity" && <ContactActivityTab contactId={contact.id} />}
      {activeTab === "files" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>File management coming in Plan 5</p>
        </div>
      )}
    </div>
  );
}
