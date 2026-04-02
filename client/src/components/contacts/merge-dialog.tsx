import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";
import { ContactCategoryBadge } from "./contact-category-badge";
import { mergeDuplicate } from "@/hooks/use-duplicate-queue";
import type { Contact } from "@/hooks/use-contacts";
import { Loader2, Trophy } from "lucide-react";

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queueEntryId: string;
  contactA: Contact;
  contactB: Contact;
  onSuccess: () => void;
}

export function MergeDialog({
  open,
  onOpenChange,
  queueEntryId,
  contactA,
  contactB,
  onSuccess,
}: MergeDialogProps) {
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMerge = async () => {
    if (!winnerId) return;
    const loserId = winnerId === contactA.id ? contactB.id : contactA.id;

    setMerging(true);
    setError(null);
    try {
      await mergeDuplicate(queueEntryId, winnerId, loserId);
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const renderContactCard = (contact: Contact, isSelected: boolean) => (
    <Card
      className={`p-4 cursor-pointer transition-colors ${
        isSelected
          ? "ring-2 ring-brand-purple bg-purple-50"
          : "hover:bg-muted/50"
      }`}
      onClick={() => setWinnerId(contact.id)}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="font-semibold">{fullName(contact)}</p>
            <ContactCategoryBadge category={contact.category} />
          </div>
          {isSelected && (
            <Badge className="bg-brand-purple text-white">
              <Trophy className="h-3 w-3 mr-1" />
              Winner
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground space-y-0.5">
          {contact.email && <p>{contact.email}</p>}
          {contact.phone && <p>{formatPhone(contact.phone)}</p>}
          {contact.companyName && <p>{contact.companyName}</p>}
          {contact.jobTitle && <p>{contact.jobTitle}</p>}
          {contactLocation(contact) && <p>{contactLocation(contact)}</p>}
          <p>Touchpoints: {contact.touchpointCount}</p>
        </div>
      </div>
    </Card>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge Contacts</DialogTitle>
          <DialogDescription>
            Select the contact to keep (winner). All deals, emails, activities, and files from the
            other contact will be transferred to the winner. The loser will be deactivated.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {renderContactCard(contactA, winnerId === contactA.id)}
          {renderContactCard(contactB, winnerId === contactB.id)}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleMerge} disabled={!winnerId || merging}>
            {merging && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Merge Contacts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
