import { Loader2 } from "lucide-react";
import { Navigate } from "react-router-dom";
import { cleanupReturnTo, mainCrmUrl } from "../components/layout";
import { Button, Panel } from "../components/ui";
import { useMe } from "../hooks/use-cleanup";

export function LoginPage() {
  const { data: user, isLoading, isError } = useMe();
  const params = new URLSearchParams(window.location.search);
  const loggedOut = params.get("loggedOut") === "1" || window.localStorage.getItem("cleanup_logged_out") === "true";
  const currentReturnTo = cleanupReturnTo(params.get("returnTo"));

  function mainCrmLoginUrl() {
    const url = new URL(mainCrmUrl("/login"));
    url.searchParams.set("returnTo", currentReturnTo);
    return url.toString();
  }

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
    if (loggedOut) {
      return (
        <main className="grid min-h-screen place-items-center bg-stone-100 px-6 text-stone-950">
          <Panel className="w-full max-w-md p-6">
            <p className="text-sm font-bold uppercase tracking-wide text-red-800">Signed out</p>
            <h1 className="mt-2 text-2xl font-black text-stone-950">Cleanup session ended</h1>
            <p className="mt-2 text-sm leading-6 text-stone-600">Sign in through the CRM when you are ready to return to cleanup.</p>
            <Button
              className="mt-5 w-full"
              onClick={() => {
                window.localStorage.removeItem("cleanup_logged_out");
                window.location.assign(mainCrmLoginUrl());
              }}
            >
              Sign in
            </Button>
          </Panel>
        </main>
      );
    }
    window.location.assign(mainCrmLoginUrl());
    return null;
  }

  if (loggedOut) window.localStorage.removeItem("cleanup_logged_out");

  if (user.onboardingCompletedAt) {
    window.location.assign(mainCrmUrl("/dashboard"));
    return null;
  }

  return <Navigate to="/cleanup" replace />;
}
