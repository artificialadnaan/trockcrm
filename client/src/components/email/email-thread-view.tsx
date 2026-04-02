import DOMPurify from "dompurify";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEmailThread } from "@/hooks/use-emails";

interface EmailThreadViewProps {
  conversationId: string;
  onBack: () => void;
}

export function EmailThreadView({ conversationId, onBack }: EmailThreadViewProps) {
  const { emails, loading, error } = useEmailThread(conversationId);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-32 bg-muted animate-pulse rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <p className="text-red-600 text-sm mt-2">{error}</p>
      </div>
    );
  }

  const subject = emails[0]?.subject ?? "(No Subject)";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h3 className="font-medium">{subject}</h3>
        <span className="text-xs text-muted-foreground">
          {emails.length} message{emails.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {emails.map((email) => {
          const isInbound = email.direction === "inbound";
          return (
            <div
              key={email.id}
              className={`border rounded-lg p-4 ${
                isInbound ? "border-l-4 border-l-blue-400" : "border-l-4 border-l-green-400"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {isInbound ? (
                    <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 text-green-500" />
                  )}
                  <span className="text-sm font-medium">
                    {isInbound ? email.fromAddress : `To: ${email.toAddresses.join(", ")}`}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(email.sentAt).toLocaleString()}
                </span>
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(email.bodyHtml ?? email.bodyPreview ?? ""),
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
