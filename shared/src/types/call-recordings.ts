import type { UserRole } from "./enums.js";

export const CALL_RECORDING_VIEW_ROLES = ["admin", "director", "rep", "construction"] as const;
export const CALL_RECORDING_UPLOAD_ROLES = ["admin", "director", "rep"] as const;

export type CallRecordingViewRole = (typeof CALL_RECORDING_VIEW_ROLES)[number];
export type CallRecordingUploadRole = (typeof CALL_RECORDING_UPLOAD_ROLES)[number];

export function canViewCallRecordings(role: string | null | undefined): role is CallRecordingViewRole {
  return Boolean(role && CALL_RECORDING_VIEW_ROLES.includes(role as UserRole & CallRecordingViewRole));
}

export function canUploadCallRecordings(role: string | null | undefined): role is CallRecordingUploadRole {
  return Boolean(role && CALL_RECORDING_UPLOAD_ROLES.includes(role as UserRole & CallRecordingUploadRole));
}
