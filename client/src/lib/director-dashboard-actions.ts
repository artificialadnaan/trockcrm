export interface DirectorDashboardAction {
  key: string;
  label: string;
  title: string;
  to: string;
}

export const DIRECTOR_DASHBOARD_ACTIONS: DirectorDashboardAction[] = [
  {
    key: "reports",
    label: "Open Reports",
    title: "Open reports workspace",
    to: "/reports",
  },
  {
    key: "alerts",
    label: "Open AI Actions",
    title: "Open AI action queue",
    to: "/admin/ai-actions",
  },
];
