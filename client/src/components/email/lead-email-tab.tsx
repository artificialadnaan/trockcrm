import { useEffect, useState } from "react";
import { EmailList } from "./email-list";
import { GraphAuthBanner } from "./graph-auth-banner";
import { useLeadEmails } from "@/hooks/use-emails";

export function LeadEmailTab({ leadId }: { leadId: string }) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [leadId]);

  const { emails, pagination, loading, error } = useLeadEmails(leadId, {
    page,
    limit: 15,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Email</h3>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails linked to this lead yet."
      />
    </div>
  );
}
