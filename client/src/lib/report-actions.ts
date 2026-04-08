export interface DisabledActionConfig {
  label: string;
  disabled: boolean;
  title?: string;
}

export function getScheduleReportActionConfig(): DisabledActionConfig {
  return {
    label: "Schedule Report (Coming Soon)",
    disabled: true,
    title: "Report scheduling is not available yet.",
  };
}
