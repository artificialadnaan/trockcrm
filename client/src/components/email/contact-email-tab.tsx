import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmailList } from "./email-list";
import { EmailComposeDialog } from "./email-compose-dialog";
import { GraphAuthBanner } from "./graph-auth-banner";
import { useContactEmails } from "@/hooks/use-emails";

interface ContactEmailTabProps {
  contactId: string;
  contactEmail?: string | null;
}

export function ContactEmailTab({ contactId, contactEmail }: ContactEmailTabProps) {
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  const { emails, pagination, loading, error, refetch } = useContactEmails(contactId, {
    page,
    limit: 15,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Email</h3>
        <Button size="sm" onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Compose
        </Button>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails for this contact yet."
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={contactEmail ?? undefined}
        contactId={contactId}
      />
    </div>
  );
}
