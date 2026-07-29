import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmailList } from "./email-list";
import { EmailComposeDialog } from "./email-compose-dialog";
import { EmailManualAssignmentDialog } from "./email-manual-assignment-dialog";
import { GraphAuthBanner } from "./graph-auth-banner";
import {
  associateEmailToEntity,
  detachEmailThread,
  reassignEmailThread,
  useDealEmails,
  useEmailThread,
  type Email,
  type EmailAssociationTarget,
} from "@/hooks/use-emails";

interface DealEmailTabProps {
  dealId: string;
  primaryContactEmail?: string | null;
}

// Module-level so the picker gets a STABLE reference. Its search effect lists the search types among
// its deps, so a fresh array literal on every parent render would restart the debounce each time.
const REASSIGN_SEARCH_TYPES: EmailAssociationTarget["assignedEntityType"][] = ["deal"];

/**
 * What the user is told a reassign will actually DO, before they pick a deal.
 *
 * A reassign moves the whole CONVERSATION, not the row they clicked, so the count is the point: it is
 * the difference between filing one stray reply and silently moving a fortnight of correspondence off
 * a deal. `messageCount` comes from the thread payload, which the server dedupes across per-mailbox
 * copies, so it counts real messages rather than rows.
 *
 * The no-conversation case says so instead of moving silently. 31 of ~10k production messages carry a
 * null graphConversationId, and those move ALONE via the single-message associate route — the opposite
 * blast radius from every other row in the list, which is exactly why it has to be stated.
 */
function describeReassignImpact(email: Email | null, messageCount: number | null): string {
  if (!email) return "";
  if (!email.graphConversationId) {
    return "This message isn't part of a tracked conversation — only it will move, not a whole thread.";
  }
  if (messageCount === null) {
    return "Moves this whole conversation to the deal you pick, so future replies land there too.";
  }
  return `Moves ${messageCount} ${messageCount === 1 ? "message" : "messages"} to the deal you pick, so future replies land there too.`;
}

export function DealEmailTab({ dealId, primaryContactEmail }: DealEmailTabProps) {
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [reassignEmail, setReassignEmail] = useState<Email | null>(null);

  useEffect(() => {
    setPage(1);
  }, [dealId]);

  const { emails, pagination, loading, error, refetch } = useDealEmails(dealId, {
    page,
    limit: 20,
  });

  // The thread of whatever row the picker is currently open for, read ONLY to tell the user how much
  // moves. `graphConversationId` is nullable and the thread routes are keyed on it, so a null one
  // means "no thread to size" and the hook is deliberately handed undefined rather than a fabricated
  // id (it then fetches nothing).
  const reassignConversationId = reassignEmail?.graphConversationId ?? undefined;
  const { thread } = useEmailThread(reassignConversationId);

  // useEmailThread keeps its last payload when the conversation id goes away, so trust the count only
  // while it demonstrably belongs to the row now selected — otherwise reopening the picker on a
  // different email would quote the PREVIOUS thread's size for a render.
  const threadMessageCount =
    reassignConversationId !== undefined &&
    thread.emails.length > 0 &&
    thread.emails[0].graphConversationId === reassignConversationId
      ? thread.emails.length
      : null;

  const reassignDescription = describeReassignImpact(reassignEmail, threadMessageCount);

  async function handleUnassign(email: Email) {
    // No single-message equivalent of detach exists — the route is keyed on the conversation — so say
    // that plainly rather than firing a request that 404s on an encoded "null".
    if (!email.graphConversationId) {
      toast.error("This message isn't part of a tracked conversation, so it can't be unassigned from here.");
      return;
    }

    if (
      !window.confirm(
        "Unassign this conversation from the deal? It returns to the assignment queue until someone files it again."
      )
    ) {
      return;
    }

    try {
      await detachEmailThread(email.graphConversationId);
      toast.success("Conversation unassigned");
      refetch();
    } catch (err: unknown) {
      // Includes the server's 403 for a caller who may not touch this thread; its message is written to
      // be read by a user, so show it rather than a generic failure.
      toast.error(err instanceof Error ? err.message : "Failed to unassign conversation");
    }
  }

  async function handleReassign(target: EmailAssociationTarget) {
    if (!reassignEmail) return;

    try {
      if (reassignEmail.graphConversationId) {
        await reassignEmailThread(reassignEmail.graphConversationId, target.assignedEntityId);
        toast.success("Conversation reassigned");
      } else {
        await associateEmailToEntity(reassignEmail.id, target);
        toast.success("Email reassigned");
      }
      refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to reassign email");
      // Rethrown on purpose: the picker closes on a resolved onAssign and stays open with the message
      // inline when it rejects. Swallowing here would shut the dialog on a 403 and leave the toast as
      // the only trace that nothing moved.
      throw err;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Emails</h3>
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
        emptyMessage="No emails linked to this deal yet."
        onReassign={(email) => setReassignEmail(email)}
        onUnassign={(email) => void handleUnassign(email)}
      />

      <EmailManualAssignmentDialog
        open={reassignEmail !== null}
        onOpenChange={(open) => {
          if (!open) setReassignEmail(null);
        }}
        title="Reassign to another deal"
        description={reassignDescription}
        searchTypes={REASSIGN_SEARCH_TYPES}
        onAssign={handleReassign}
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={primaryContactEmail ?? undefined}
        dealId={dealId}
      />
    </div>
  );
}
