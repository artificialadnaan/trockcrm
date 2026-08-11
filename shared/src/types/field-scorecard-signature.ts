/**
 * Signature classification shared by EVERY surface that renders a scorecard signature — the web deal tab
 * and the server PDF renderer. A handwritten signature is captured in T-Rock Cam as a data URL; legacy
 * cards carry a plain typed name instead.
 *
 * Both surfaces MUST classify identically. If the web accepted a payload the PDF rejects (or vice versa),
 * one surface would show a signature the other renders as an em dash — the same class of drift the
 * reconciliation-consistency rule exists to prevent. That is why this lives in shared/ rather than being
 * duplicated per surface.
 */

/** png/jpeg/jpg only, matching what both PDFKit's doc.image() decodes and an <img src> can safely take. */
const RENDERABLE_SIGNATURE_DATA_URL = /^data:image\/(?:png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * True when the value is a handwritten-signature data URL this platform will draw as an image.
 *
 * Deliberately NARROW: any other `data:` payload (svg+xml, text/html, an unknown image type, or a
 * malformed base64 body) is false, so callers never pass an arbitrary data URI into an image sink.
 */
export function isRenderableSignatureDataUrl(value: string | null | undefined): boolean {
  return !!signatureDataUrlBase64Body(value);
}

/** The decoded base64 body of a renderable signature data URL, or null. Server-side image decode path. */
export function signatureDataUrlBase64Body(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = RENDERABLE_SIGNATURE_DATA_URL.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * The legacy typed-signature text to render when there is no drawable image: a plain typed name renders
 * as text, while ANY data URL returns null (an unrenderable data URL must fall through to an em dash, not
 * be printed verbatim — printing it verbatim is the reported bug).
 *
 * The `data:` test is case-INSENSITIVE on purpose. The renderable-image regex above is case-insensitive,
 * so a case-sensitive test here would disagree with it: `DATA:TEXT/HTML;base64,…` is not renderable, and a
 * `startsWith("data:")` check would miss it and print the raw payload as if it were a typed name.
 *
 * Trimmed for the same reason, and to match the mobile copy of this rule: a value with leading whitespace
 * would otherwise fail BOTH the renderable check and this one, and the raw base64 would print as a text
 * node — precisely the defect this module exists to prevent.
 */
export function typedSignatureFallback(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^data:/i.test(trimmed) ? null : trimmed;
}
