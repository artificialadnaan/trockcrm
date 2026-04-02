import { Activity, Calendar, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Contact } from "@/hooks/use-contacts";

interface ContactTouchpointCardProps {
  contact: Contact;
}

export function ContactTouchpointCard({ contact }: ContactTouchpointCardProps) {
  const lastContacted = contact.lastContactedAt
    ? new Date(contact.lastContactedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Never";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Touchpoints</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Total Touchpoints
          </span>
          <span className="font-semibold text-lg">{contact.touchpointCount}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Last Contacted
          </span>
          <span className="text-sm">{lastContacted}</span>
        </div>
        {!contact.firstOutreachCompleted && (
          <div className="flex items-center gap-2 bg-amber-50 text-amber-800 p-2 rounded text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>First outreach not yet completed</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
