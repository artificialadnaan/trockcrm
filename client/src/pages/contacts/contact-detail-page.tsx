import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  Briefcase,
  Building2,
  Edit,
  FileText,
  Mail,
  MoreHorizontal,
  Phone,
  Trash2,
  UserRound,
  Voicemail,
  Star,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  type DetailPageShellTab,
} from "@/components/layout/detail-page-shell";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { ContactCategoryBadge } from "@/components/contacts/contact-category-badge";
import { ContactDealsTab } from "@/components/contacts/contact-deals-tab";
import { ContactActivityTab } from "@/components/contacts/contact-activity-tab";
import { ContactEmailTab } from "@/components/email/contact-email-tab";
import { ContactFileTab } from "@/components/files/contact-file-tab";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { useContactDetail, deleteContact as apiDeleteContact, type Contact } from "@/hooks/use-contacts";
import { useAuth } from "@/lib/auth";
import { contactLocation, formatPhone, fullName } from "@/lib/contact-utils";

type Tab = "deals" | "email" | "activity" | "files" | "recordings";

function formatDate(value: string | null | undefined) {
  if (!value) return "No activity recorded";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatCategory(value: string | null | undefined) {
  return (value ?? "contact").replace(/_/g, " ").toUpperCase();
}

function contactInitials(contact: Contact) {
  return `${contact.firstName?.[0] ?? ""}${contact.lastName?.[0] ?? ""}`.toUpperCase() || "C";
}

function ContactRightRail({ contact }: { contact: Contact }) {
  const location = contactLocation(contact);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <DetailRailSection title="Company">
          {contact.companyId ? (
            <Link className="font-semibold text-slate-950 underline-offset-4 hover:underline" to={`/companies/${contact.companyId}`}>
              {contact.companyName ?? "Linked company"}
            </Link>
          ) : (
            <p className="font-semibold text-slate-900">{contact.companyName ?? "Unassigned"}</p>
          )}
        </DetailRailSection>

        <DetailRailSection title="Role">
          <DetailRailItem label="Job Title" value={contact.jobTitle ?? "Not set"} />
          {contact.role ? <DetailRailItem label="Role" value={contact.role} /> : null}
          <DetailRailItem label="Category" value={formatCategory(contact.category)} />
        </DetailRailSection>

        {contact.linkedinUrl ? (
          <DetailRailSection title="LinkedIn">
            <a
              href={contact.linkedinUrl.startsWith("http") ? contact.linkedinUrl : `https://${contact.linkedinUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-slate-900 underline-offset-4 hover:underline"
            >
              {contact.linkedinUrl.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </DetailRailSection>
        ) : null}

        <DetailRailSection title="Contact Methods">
          <DetailRailItem
            label="Email"
            value={
              contact.email ? (
                <a href={`mailto:${contact.email}`} className="underline-offset-4 hover:underline">
                  {contact.email}
                </a>
              ) : (
                "Not set"
              )
            }
          />
          <DetailRailItem label="Phone" value={contact.phone ? formatPhone(contact.phone) : "Not set"} />
          {contact.mobile ? <DetailRailItem label="Mobile" value={formatPhone(contact.mobile)} /> : null}
        </DetailRailSection>

        {(contact.address || location || contact.zip) && (
          <DetailRailSection title="Address">
            <p className="font-semibold text-slate-900">
              {[contact.address, location, contact.zip].filter(Boolean).join(", ")}
            </p>
          </DetailRailSection>
        )}

        <DetailRailSection title="System IDs">
          <DetailRailItem label="Procore" value={contact.procoreContactId ?? "Not linked"} />
          <DetailRailItem label="HubSpot" value={contact.hubspotContactId ?? "Not linked"} />
        </DetailRailSection>

        <DetailRailSection title="Activity">
          <DetailRailItem label="Touchpoints" value={String(contact.touchpointCount ?? 0)} />
          <DetailRailItem label="Last Activity" value={formatDate(contact.lastTouchAt ?? contact.lastContactedAt)} />
        </DetailRailSection>
      </CardContent>
    </Card>
  );
}

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { contact, loading, error } = useContactDetail(id);
  const [activeTab, setActiveTab] = useState<Tab>("deals");

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Contact not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/contacts")}>
          Back to Contacts
        </Button>
      </div>
    );
  }

  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";
  const location = contactLocation(contact);
  const name = fullName(contact);

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this contact?")) return;
    try {
      await apiDeleteContact(contact.id);
      navigate("/contacts");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete contact");
    }
  };

  const tabs: DetailPageShellTab[] = [
    { id: "deals", label: "Deals", icon: <Briefcase className="h-4 w-4" />, count: contact.linkedDealsCount },
    { id: "email", label: "Email", icon: <Mail className="h-4 w-4" /> },
    { id: "activity", label: "Activity", icon: <Activity className="h-4 w-4" />, count: contact.touchpointCount },
    { id: "files", label: "Files", icon: <FileText className="h-4 w-4" /> },
    { id: "recordings", label: "Recordings", icon: <Voicemail className="h-4 w-4" /> },
  ];

  const subtitleParts = [contact.companyName, contact.jobTitle, location].filter(Boolean);

  return (
    <DetailPageShell
      parentLabel="Contacts"
      parentHref="/contacts"
      currentLabel={name}
      iconSlot={<span className="text-2xl font-black">{contactInitials(contact)}</span>}
      typeBadge={<ContactCategoryBadge category={contact.category} />}
      statusBadge={
        <span className="inline-flex flex-wrap items-center gap-2">
          {contact.isPrimary ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700 ring-1 ring-amber-200">
              <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
              Primary
            </span>
          ) : null}
          {contact.isActive ? (
            <span className="rounded-full bg-red-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-brand-red">
              Active Contact
            </span>
          ) : null}
        </span>
      }
      title={name}
      subtitleSlot={
        subtitleParts.length ? (
          <>
            <Building2 className="h-4 w-4 text-slate-400" />
            <span>{subtitleParts.join(" · ")}</span>
          </>
        ) : undefined
      }
      actionsSlot={
        <>
          <TaskCreateDialog defaultContactId={contact.id} onCreated={() => {}} />
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to={`/contacts/${contact.id}/edit`} />}>
            <Edit className="h-4 w-4" />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/contacts/${contact.id}/edit`)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit Contact
              </DropdownMenuItem>
              {isDirectorOrAdmin ? (
                <DropdownMenuItem onClick={handleDelete} className="text-red-600">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Contact
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      kpis={[
        {
          eyebrow: "Linked Deals",
          value: String(contact.linkedDealsCount ?? 0),
          captionLabel: "Deals",
          captionContext: "connected to this contact",
        },
        {
          eyebrow: "Touchpoints",
          value: String(contact.touchpointCount ?? 0),
          captionContext: contact.firstOutreachCompleted ? "first outreach complete" : "first outreach pending",
        },
        {
          eyebrow: "Last Activity",
          value: contact.lastTouchAt || contact.lastContactedAt ? formatDate(contact.lastTouchAt ?? contact.lastContactedAt) : "None",
          accent: "red",
          captionContext: "contact history",
        },
      ]}
      tabs={tabs}
      activeTabId={activeTab}
      onTabChange={(tabId) => setActiveTab(tabId as Tab)}
      rightRail={<ContactRightRail contact={contact} />}
    >
      {contact.notes ? (
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Notes</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{contact.notes}</p>
        </div>
      ) : null}

      {activeTab === "deals" && <ContactDealsTab contactId={contact.id} contact={contact} />}
      {activeTab === "email" && <ContactEmailTab contactId={contact.id} contactEmail={contact.email} />}
      {activeTab === "activity" && <ContactActivityTab contactId={contact.id} />}
      {activeTab === "files" && <ContactFileTab contactId={contact.id} />}
      {activeTab === "recordings" && <RecordingList entityType="contact" entityId={contact.id} />}
    </DetailPageShell>
  );
}
