import { useState } from "react";
import { Phone, FileText, Calendar, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";

interface ContactActivityTabProps {
  contactId: string;
}

type LogType = "call" | "note" | "meeting";

export function ContactActivityTab({ contactId }: ContactActivityTabProps) {
  const [activeForm, setActiveForm] = useState<LogType | null>(null);
  const [body, setBody] = useState("");

  const handleSubmit = async (type: LogType) => {
    if (!body.trim()) return;
    // TODO (Plan 4 -- Tasks/Activities): Replace with actual API call once
    // the activities endpoint exists. For now, log locally as a fallback.
    try {
      await fetch(`/api/contacts/${contactId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          subject: `${type} logged`,
          body: body.trim(),
          dealId: null,
          contactId,
        }),
      });
    } catch {
      // Endpoint doesn't exist yet -- fall back to console until Plan 4
      console.log("[ActivityTab] Log entry:", { contactId, type, body });
    }
    setBody("");
    setActiveForm(null);
  };

  return (
    <div className="space-y-4">
      {/* Quick-log action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={activeForm === "call" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "call" ? null : "call")}
        >
          <Phone className="h-4 w-4 mr-1" /> Log Call
        </Button>
        <Button
          size="sm"
          variant={activeForm === "note" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "note" ? null : "note")}
        >
          <FileText className="h-4 w-4 mr-1" /> Add Note
        </Button>
        <Button
          size="sm"
          variant={activeForm === "meeting" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "meeting" ? null : "meeting")}
        >
          <Calendar className="h-4 w-4 mr-1" /> Log Meeting
        </Button>
      </div>

      {/* Inline log form */}
      {activeForm && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium capitalize">{activeForm} details</p>
            <Textarea
              placeholder={`Describe this ${activeForm}...`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleSubmit(activeForm)}>
                <Plus className="h-4 w-4 mr-1" /> Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setActiveForm(null); setBody(""); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activity feed -- populated in Plan 4 */}
      <div className="text-center py-8 text-muted-foreground text-sm">
        Activity history will appear here once Plan 4 (Activities) is implemented.
      </div>
    </div>
  );
}
