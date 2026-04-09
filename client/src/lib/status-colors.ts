// Shared status color classes — single source of truth for badge/pill styling

export const PRIORITY_COLORS: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-700 border-amber-200",
  normal: "bg-blue-100 text-blue-700 border-blue-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

export const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  not_started: "bg-gray-100 text-gray-600 border-gray-200",
  drafting: "bg-blue-100 text-blue-700 border-blue-200",
  sent: "bg-amber-100 text-amber-700 border-amber-200",
  under_review: "bg-purple-100 text-purple-700 border-purple-200",
  revision_requested: "bg-orange-100 text-orange-700 border-orange-200",
  accepted: "bg-green-100 text-green-700 border-green-200",
  signed: "bg-green-200 text-green-900 border-green-300 font-semibold",
  rejected: "bg-red-100 text-red-700 border-red-200",
};

export const PUNCH_STATUS_COLORS: Record<string, string> = {
  open: "bg-gray-100 text-gray-600 border-gray-200",
  in_progress: "bg-amber-100 text-amber-700 border-amber-200",
  completed: "bg-green-100 text-green-700 border-green-200",
};
