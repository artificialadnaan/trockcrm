import { Ban } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Shown at /commissions in place of the rep commissions dashboard while the
 * page is disabled. Reps still see the nav link; clicking it lands here.
 * Re-enable by pointing the /commissions route back at <RepCommissionsPage />.
 */
export function CommissionsDisabledPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-16 text-center">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Ban className="h-7 w-7 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold">This page has been disabled</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            The Commissions page is temporarily unavailable. Please check back later, or
            contact your admin if you have questions about your commissions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
