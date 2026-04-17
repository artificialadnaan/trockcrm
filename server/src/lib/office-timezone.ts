import { AppError } from "../middleware/error-handler.js";

export const DEFAULT_OFFICE_TIMEZONE = "America/Chicago";
const OFFICE_LOCAL_SEND_GRACE_MINUTES = 5;

type OfficeTimezoneInput = {
  timezone?: string | null;
} | null | undefined;

function isSupportedTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function getOfficeTimezone(input: OfficeTimezoneInput) {
  const timezone = input?.timezone?.trim();
  if (!timezone) return DEFAULT_OFFICE_TIMEZONE;
  if (!isSupportedTimeZone(timezone)) {
    throw new AppError(400, "Invalid office timezone");
  }
  return timezone;
}

export function getOfficeLocalTimeParts(input: { timezone: string; nowUtc: Date }) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(input.nowUtc).map((part) => [part.type, part.value]));

  const hour = Number(parts.hour ?? "0");
  const minute = Number(parts.minute ?? "0");
  const weekday = String(parts.weekday ?? "");

  return {
    hour,
    minute,
    weekday,
    isWeekend: weekday === "Sat" || weekday === "Sun",
  };
}

export function isOfficeLocalSendDue(input: { timezone: string; nowUtc: Date; targetHour: number }) {
  const timezone = getOfficeTimezone({ timezone: input.timezone });
  const parts = getOfficeLocalTimeParts({ timezone, nowUtc: input.nowUtc });

  return !parts.isWeekend && parts.hour === input.targetHour && parts.minute < OFFICE_LOCAL_SEND_GRACE_MINUTES;
}
