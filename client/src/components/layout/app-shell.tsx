import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileNav } from "./mobile-nav";

export function AppShell() {
  return (
    <div className="flex min-h-screen bg-slate-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-auto bg-slate-50 p-4 pb-20 md:p-6 md:pb-6">
          <div className="space-y-6">
            <Outlet />
          </div>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
