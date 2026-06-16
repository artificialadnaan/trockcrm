import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmailManualAssignmentDialog } from "./email-manual-assignment-dialog";
import { sendEmail, type EmailAssociationTarget } from "@/hooks/use-emails";
import { getSignature } from "@/hooks/use-signature";
import DOMPurify from "dompurify";

interface EmailComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
  defaultTo?: string;
  defaultSubject?: string;
  defaultBody?: string;
  dealId?: string;
  contactId?: string;
}

export function EmailComposeDialog({
  open,
  onOpenChange,
  onSent,
  defaultTo,
  defaultSubject,
  defaultBody,
  dealId,
  contactId,
}: EmailComposeDialogProps) {
  const defaultAssociation = useMemo<EmailAssociationTarget | null>(() => {
    if (dealId) {
      return {
        assignedEntityType: "deal",
        assignedEntityId: dealId,
        assignedDealId: dealId,
        displayLabel: "Deal selected",
      };
    }

    if (contactId) {
      return {
        assignedEntityType: "contact",
        assignedEntityId: contactId,
        assignedDealId: null,
        displayLabel: "Contact selected",
      };
    }

    return null;
  }, [contactId, dealId]);

  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [association, setAssociation] = useState<EmailAssociationTarget | null>(defaultAssociation);
  const [associationPickerOpen, setAssociationPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sender's stored signature is appended server-side at send (single source of truth); we fetch
  // it here only to show a read-only "will be added" preview so the user sees what goes out.
  const [signature, setSignature] = useState("");

  useEffect(() => {
    if (!open) return;
    setTo(defaultTo ?? "");
    setCc("");
    setSubject(defaultSubject ?? "");
    setBody(defaultBody ?? "");
    setAssociation(defaultAssociation);
    setError(null);
    void getSignature()
      .then(setSignature)
      .catch(() => setSignature(""));
  }, [defaultAssociation, defaultBody, defaultSubject, defaultTo, open]);

  const canSend = Boolean(association && to.trim() && subject.trim() && !sending);

  const handleSend = async () => {
    if (!association) {
      setError("Association is required");
      return;
    }
    if (!to.trim()) {
      setError("Recipient is required");
      return;
    }
    if (!subject.trim()) {
      setError("Subject is required");
      return;
    }
    if (!body.trim()) {
      setError("Message body is required");
      return;
    }

    setSending(true);
    setError(null);

    try {
      const toList = to
        .split(/[,;]/)
        .map((e) => e.trim())
        .filter(Boolean);
      const ccList = cc
        ? cc
            .split(/[,;]/)
            .map((e) => e.trim())
            .filter(Boolean)
        : undefined;

      // Wrap plain text in basic HTML
      const bodyHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5;">${body
        .split("\n")
        .map((line) => `<p style="margin: 0 0 8px 0;">${escapeHtml(line) || "&nbsp;"}</p>`)
        .join("")}</div>`;

      await sendEmail({
        to: toList,
        cc: ccList,
        subject: subject.trim(),
        bodyHtml,
        assignedEntityType: association.assignedEntityType,
        assignedEntityId: association.assignedEntityId,
        assignedDealId: association.assignedDealId,
        dealId: association.assignedEntityType === "deal" ? association.assignedEntityId : null,
        contactId: association.assignedEntityType === "contact" ? association.assignedEntityId : null,
      });

      onOpenChange(false);
      onSent?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="email-association">Associate to</Label>
            <Button
              id="email-association"
              type="button"
              variant="outline"
              className="mt-1 w-full justify-between font-normal"
              onClick={() => setAssociationPickerOpen(true)}
            >
              <span className={association ? "truncate" : "truncate text-muted-foreground"}>
                {association?.displayLabel ?? "Pick a deal, company, contact, or lead"}
              </span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </div>

          <div>
            <Label htmlFor="email-to">To</Label>
            <Input
              id="email-to"
              placeholder="recipient@example.com (separate multiple with commas)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-cc">CC</Label>
            <Input
              id="email-cc"
              placeholder="cc@example.com (optional)"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              placeholder="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-body">Message</Label>
            <textarea
              id="email-body"
              className="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Type your message..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {signature ? (
            <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Your signature will be added
              </p>
              <div
                className="text-sm text-slate-700"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature) }}
              />
            </div>
          ) : null}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={!canSend}>
              {sending ? (
                "Sending..."
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>

      <EmailManualAssignmentDialog
        open={associationPickerOpen}
        onOpenChange={setAssociationPickerOpen}
        onAssign={async (target) => {
          setAssociation(target);
          setError(null);
        }}
        title="Associate outbound email"
        description="Search the CRM and attach this email to a deal, lead, contact, or company before sending."
        searchTypes={["deal", "lead", "contact", "company"]}
      />
    </Dialog>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
