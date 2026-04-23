import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { InvitePreview } from "@/hooks/use-admin-users";

type UserInvitePreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: InvitePreview | null;
  loading?: boolean;
};

export function UserInvitePreviewDialog(props: UserInvitePreviewDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Invite Preview</DialogTitle>
          <DialogDescription>
            This preview never sends email. The temporary password is generated only when the invite is sent.
          </DialogDescription>
        </DialogHeader>

        {props.loading ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">
            Loading invite preview...
          </div>
        ) : props.preview ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-slate-50 p-3">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Recipient</div>
                <div className="mt-1 text-sm text-slate-900">{props.preview.recipientEmail}</div>
              </div>
              <div className="rounded-lg border bg-slate-50 p-3">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Login URL</div>
                <div className="mt-1 text-sm text-slate-900 break-all">{props.preview.loginUrl}</div>
              </div>
            </div>

            <div className="rounded-lg border bg-white p-3">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Subject</div>
              <div className="mt-1 text-sm font-medium text-slate-900">{props.preview.subject}</div>
            </div>

            <div className="rounded-lg border bg-white p-3">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Message</div>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-slate-700">{props.preview.text}</pre>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
