import { Mail, AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGraphAuth } from "@/hooks/use-graph-auth";

export function GraphAuthBanner() {
  const { connected, status, errorMessage, loading, startConsent } =
    useGraphAuth();

  if (loading) return null;

  // Connected and healthy -- no banner needed
  if (connected) return null;

  // Needs reauthorization
  if (status === "reauth_needed") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-amber-800">
              Email Reconnection Needed
            </h3>
            <p className="text-sm text-amber-700 mt-1">
              Your Microsoft email connection expired.
              {errorMessage && ` (${errorMessage})`}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={startConsent}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Reconnect Email
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Not connected at all
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-4">
      <div className="flex items-start gap-3">
        <Mail className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-blue-800">
            Connect Your Email
          </h3>
          <p className="text-sm text-blue-700 mt-1">
            Connect your Microsoft 365 account to send and receive emails
            directly from the CRM. Emails are automatically linked to your
            deals and contacts.
          </p>
          <Button
            size="sm"
            className="mt-2"
            onClick={startConsent}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Connect Microsoft Email
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact status indicator for the sidebar or header.
 */
export function GraphAuthStatusIndicator() {
  const { connected, status, loading } = useGraphAuth();

  if (loading) return null;

  if (connected) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-green-600">
        <CheckCircle className="h-3 w-3" />
        <span>Email connected</span>
      </div>
    );
  }

  if (status === "reauth_needed") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-600">
        <AlertTriangle className="h-3 w-3" />
        <span>Email needs reconnection</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Mail className="h-3 w-3" />
      <span>Email not connected</span>
    </div>
  );
}
