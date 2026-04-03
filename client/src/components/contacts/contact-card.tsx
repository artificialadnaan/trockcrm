import { Building2, MapPin, Phone, Mail, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ContactCategoryBadge } from "./contact-category-badge";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";
import type { Contact } from "@/hooks/use-contacts";

interface ContactCardProps {
  contact: Contact;
  onClick: () => void;
}

export function ContactCard({ contact, onClick }: ContactCardProps) {
  return (
    <Card
      className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ContactCategoryBadge category={contact.category} />
            {!contact.firstOutreachCompleted && (
              <span className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                Needs Outreach
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full bg-slate-200 text-slate-600 text-xs font-semibold">
              {[contact.firstName?.[0], contact.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?"}
            </span>
            <h3 className="font-semibold truncate">{fullName(contact)}</h3>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
            {contact.companyName && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {contact.companyName}
              </span>
            )}
            {contact.jobTitle && (
              <span>{contact.jobTitle}</span>
            )}
            {contactLocation(contact) && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {contactLocation(contact)}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0 space-y-1">
          {contact.email && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <Mail className="h-3 w-3" />
              {contact.email}
            </p>
          )}
          {(contact.phone || contact.mobile) && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <Phone className="h-3 w-3" />
              {formatPhone(contact.phone ?? contact.mobile)}
            </p>
          )}
          <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
            <Activity className="h-3 w-3" />
            {contact.touchpointCount} touchpoints
          </p>
        </div>
      </div>
    </Card>
  );
}
