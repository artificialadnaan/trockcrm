/**
 * tel:, sms: and mailto: URL construction.
 *
 * Lives in one module because the deal detail and the contact screens both build these, and both got
 * them wrong in the same two ways: a phone extension folded into the number (so Call dialled a different
 * person) and an unencoded email address (so the composer opened with a truncated recipient). Neither
 * failure announces itself — the app looks like it worked.
 */

/**
 * Trailing extension, in the forms CRM data actually contains: "ext 3", "ext. 3", "x3", "extension 3",
 * "#3". Anchored to the END so it can never swallow part of the number itself.
 */
const EXTENSION_PATTERN = /(?:\s*(?:ext(?:ension)?|x)\.?\s*|\s*#\s*)(\d{1,7})\s*$/i;

/**
 * Split a stored number into the digits to dial and the extension to send afterwards.
 *
 * Stripping every non-digit turns "214-555-1212 ext 3" into "2145551212" + "3" = a DIFFERENT eleven-digit
 * number. Tapping Call then dials a stranger, and nothing on screen says so.
 */
export function phoneParts(phone: string): { number: string; extension: string | null } {
  const trimmed = phone.trim();
  const match = EXTENSION_PATTERN.exec(trimmed);
  const head = match ? trimmed.slice(0, match.index) : trimmed;
  return { number: head.replace(/[^\d+]/g, ""), extension: match ? match[1] : null };
}

/**
 * A dialer URL. The extension rides along after commas, which every phone dialer interprets as a pause
 * before sending the remaining digits as DTMF — so the call connects and still reaches the person.
 */
export function telUrl(phone: string): string {
  const { number, extension } = phoneParts(phone);
  return extension ? `tel:${number},,${extension}` : `tel:${number}`;
}

/** An SMS URL. Never carries the extension: extensions are a dialer concept and cannot be texted. */
export function smsUrl(phone: string): string {
  return `sms:${phoneParts(phone).number}`;
}

/**
 * A mailto URL with the address percent-encoded.
 *
 * `?` and `#` are legal in an email local-part and the server's validation accepts them, but interpolated
 * raw they turn the rest of the address into a mailto QUERY or FRAGMENT — "user?tag@example.com" opens a
 * composer addressed to "user". `@` is decoded back because RFC 6068 permits it unencoded in the to-field
 * and some clients render "%40" literally.
 */
export function mailtoUrl(email: string): string {
  return `mailto:${encodeURIComponent(email.trim()).replace(/%40/g, "@")}`;
}
