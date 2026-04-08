export interface DirectorDashboardAction {
  key: string;
  label: string;
  title: string;
  to: string;
}

export const DIRECTOR_DASHBOARD_ACTIONS: DirectorDashboardAction[] = [
  {
    key: "alerts",
    label: "Open tasks",
    title: "Open task queue",
    to: "/tasks",
  },
  {
    key: "reports",
    label: "Open reports",
    title: "Open reports",
    to: "/reports",
  },
];
