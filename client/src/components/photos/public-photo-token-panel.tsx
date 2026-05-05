import { useEffect, useState } from "react";
import { Copy, Link2, Share2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface PublicPhotoToken {
  id: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  status: "active" | "expired" | "revoked";
}

export function PublicPhotoTokenPanel({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<PublicPhotoToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);

  async function loadTokens() {
    setLoading(true);
    try {
      const response = await api<{ tokens: PublicPhotoToken[] }>(`/admin/deals/${dealId}/photo-tokens`);
      setTokens(response.tokens);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load public photo links");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void loadTokens();
  }, [open]);

  async function createToken() {
    setCreating(true);
    try {
      const response = await api<{ url: string }>(`/admin/deals/${dealId}/photo-tokens`, { method: "POST", json: {} });
      setNewUrl(response.url);
      toast.success("Public photo link created");
      await loadTokens();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create public photo link");
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(tokenId: string) {
    try {
      await api(`/admin/photo-tokens/${tokenId}/revoke`, { method: "POST", json: {} });
      toast.success("Public photo link revoked");
      await loadTokens();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to revoke public photo link");
    }
  }

  async function copyUrl() {
    if (!newUrl) return;
    await navigator.clipboard?.writeText(newUrl);
    toast.success("Copied public photo link");
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Share2 className="mr-1.5 h-4 w-4" />
        Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Public photo link</DialogTitle>
            <DialogDescription>Create a read-only link for customers or Procore project links.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button type="button" onClick={createToken} disabled={creating}>
                <Link2 className="mr-1.5 h-4 w-4" />
                {creating ? "Creating..." : "Create new link"}
              </Button>
              <Button type="button" variant="outline" onClick={loadTokens} disabled={loading}>Refresh</Button>
            </div>

            {newUrl && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-medium text-emerald-950">Copy this link now. The raw token is only shown once.</p>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={newUrl} className="bg-white" />
                  <Button type="button" variant="outline" onClick={copyUrl}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading links...</p>
              ) : tokens.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No public links have been created for this deal.</p>
              ) : tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant={token.status === "active" ? "default" : "outline"}>{token.status}</Badge>
                      <span className="text-sm font-medium">Created {new Date(token.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      By {token.createdBy.name} · {token.accessCount} accesses · last accessed {token.lastAccessedAt ? new Date(token.lastAccessedAt).toLocaleString() : "never"}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={token.status !== "active"} onClick={() => revokeToken(token.id)}>
                    <XCircle className="mr-1.5 h-4 w-4" />
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
