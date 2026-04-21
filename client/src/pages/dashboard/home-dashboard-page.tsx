import { useAuth } from "@/lib/auth";
import { RepDashboardPage } from "./rep-dashboard-page";
import { AdminDashboardPage } from "./admin-dashboard-page";
import { DirectorDashboardPage } from "@/pages/director/director-dashboard-page";

export function HomeDashboardPage() {
  const { user } = useAuth();

  if (user?.role === "rep") return <RepDashboardPage />;
  if (user?.role === "admin") return <AdminDashboardPage />;
  return <DirectorDashboardPage />;
}
