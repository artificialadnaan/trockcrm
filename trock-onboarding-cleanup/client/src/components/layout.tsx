import { Outlet, useNavigate } from "react-router-dom";
import { HardHat, LogOut, Shuffle } from "lucide-react";
import { useLogout, useMe } from "../hooks/use-cleanup";
import { Button } from "./ui";

function mainCrmLoginUrlForCurrentRoute() {
  const url = new URL(mainCrmUrl("/login"));
  url.searchParams.set("returnTo", window.location.href);
  return url.toString();
}

export function AppLayout() {
  const { data: user, isLoading, isError } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  if (!isLoading && (isError || !user)) {
    window.location.assign(mainCrmLoginUrlForCurrentRoute());
    return null;
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-950">
      <header className="sticky top-0 z-20 border-b border-stone-300 bg-stone-950 text-stone-50">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <button className="flex min-h-11 items-center gap-3 text-left" onClick={() => navigate("/cleanup")}>
            <span className="grid h-9 w-9 place-items-center rounded bg-red-700">
              <HardHat className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-bold leading-tight">T Rock Onboarding</span>
              <span className="block text-xs text-stone-300">Data cleanup before CRM access</span>
            </span>
          </button>
          <div className="hidden items-center gap-3 sm:flex">
            <span className="text-sm text-stone-300">{user?.displayName ?? user?.email}</span>
            {user?.role === "admin" || user?.role === "director" ? (
              <Button variant="ghost" className="text-stone-50 hover:bg-stone-800" onClick={() => navigate("/admin/reassign")}>
                <Shuffle className="h-4 w-4" />
                Reassign
              </Button>
            ) : null}
            <Button variant="ghost" className="text-stone-50 hover:bg-stone-800" disabled={logout.isPending} onClick={() => logout.mutate()}>
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

export function mainCrmUrl(path = "") {
  const base = import.meta.env.VITE_MAIN_CRM_BASE_URL ?? "https://trockcrm.com";
  return `${base.replace(/\/$/, "")}${path}`;
}
