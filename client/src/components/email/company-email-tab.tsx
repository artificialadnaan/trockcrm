import { useEffect, useState } from "react";
import { EmailList } from "./email-list";
import { GraphAuthBanner } from "./graph-auth-banner";
import { useCompanyEmails } from "@/hooks/use-emails";

export function CompanyEmailTab({ companyId }: { companyId: string }) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [companyId]);

  const { emails, pagination, loading, error } = useCompanyEmails(companyId, {
    page,
    limit: 20,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Emails</h3>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails linked to this company yet."
      />
    </div>
  );
}
