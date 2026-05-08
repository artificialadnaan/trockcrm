import { Loader2 } from "lucide-react";
import { Navigate } from "react-router-dom";
import { mainCrmUrl } from "../components/layout";
import { useMe } from "../hooks/use-cleanup";

export function LoginPage() {
  const { data: user, isLoading, isError } = useMe();

  if (isLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-100 px-6 text-stone-950">
        <div className="flex items-center gap-3 rounded-md border border-stone-300 bg-stone-50 px-5 py-4 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin text-red-700" />
          <span className="text-sm font-semibold">Checking your cleanup access</span>
        </div>
      </main>
    );
  }

  if (isError || !user) {
    window.location.assign(mainCrmUrl("/login"));
    return null;
  }

  if (user.onboardingCompletedAt) {
    window.location.assign(mainCrmUrl("/dashboard"));
    return null;
  }

  return <Navigate to="/cleanup" replace />;
}
