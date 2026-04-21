import { useAuth } from "@/lib/auth";
import { AdminDashboardPage } from "@/pages/dashboard/admin-dashboard-page";
import { RepDashboardPage } from "@/pages/dashboard/rep-dashboard-page";
import { DirectorDashboardPage } from "@/pages/director/director-dashboard-page";

export function HomeDashboardPage() {
  const { user } = useAuth();
  if (user?.role === "rep") return <RepDashboardPage />;
  if (user?.role === "admin") return <AdminDashboardPage />;
  return <DirectorDashboardPage />;
}
