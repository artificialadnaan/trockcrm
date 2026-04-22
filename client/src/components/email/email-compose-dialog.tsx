import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sendEmail } from "@/hooks/use-emails";

interface EmailComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
  defaultTo?: string;
  dealId?: string;
  contactId?: string;
}

export function EmailComposeDialog({
  open,
  onOpenChange,
  onSent,
  defaultTo,
  dealId,
  contactId,
}: EmailComposeDialogProps) {
  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTo(defaultTo ?? "");
    setCc("");
    setSubject("");
    setBody("");
    setError(null);
  }, [defaultTo, open]);

  const handleSend = async () => {
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
        dealId,
        contactId,
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
            <Button onClick={handleSend} disabled={sending}>
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
