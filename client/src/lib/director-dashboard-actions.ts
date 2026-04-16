export interface DirectorDashboardAction {
  key: string;
  label: string;
  title: string;
  to: string;
}

export const DIRECTOR_DASHBOARD_ACTIONS: DirectorDashboardAction[] = [
  {
    key: "alerts",
    label: "Open AI actions",
    title: "Open AI action queue",
    to: "/admin/ai-actions",
  },
  {
    key: "reports",
    label: "Open reports",
    title: "Open reports",
    to: "/reports",
  },
];
