import sanitizeHtml from "sanitize-html";

/**
 * Authoritative server-side sanitizer for a user's email-signature HTML.
 *
 * Signatures are user-pasted/edited HTML that gets injected into OUTBOUND mail, so this is the
 * security boundary: an allowlist of safe formatting + links + a logo <img>, with scripts, event
 * handlers (on*), <style>/<iframe>/<object>/<form>, and javascript:/data: URLs all stripped. The
 * client may pre-sanitize for preview, but this server pass is the one that decides what is stored
 * and sent — never trust the client copy.
 */

// Length cap before we even parse — a signature is a small fixed block, not a document.
export const MAX_SIGNATURE_HTML_BYTES = 50_000;

const ALLOWED_STYLES_VALUE = [/^[^;{}()<>]*$/]; // no CSS that could break out (no braces/parens/url())

const STYLE_PROPS = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-align",
  "text-decoration",
  "line-height",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "width",
  "height",
  "max-width",
  "display",
  "vertical-align",
  "border",
  "border-top",
  "border-bottom",
  "border-collapse",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "div", "span", "a", "img",
    "b", "strong", "i", "em", "u", "s", "sub", "sup", "small", "font",
    "h3", "h4", "ul", "ol", "li", "hr",
    "table", "thead", "tbody", "tr", "td", "th",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel", "style"],
    img: ["src", "alt", "title", "width", "height", "style"],
    font: ["color", "face", "size"],
    table: ["style", "align", "width", "cellpadding", "cellspacing", "border"],
    td: ["style", "align", "valign", "width"],
    th: ["style", "align", "valign", "width"],
    tr: ["style", "align", "valign"],
    "*": ["style", "align"],
  },
  // Links may be web or mail/phone; images must be a real hosted URL (we never base64-embed).
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowedStyles: {
    "*": Object.fromEntries(STYLE_PROPS.map((p) => [p, ALLOWED_STYLES_VALUE])),
  },
  // Drop disallowed tags entirely (no leftover text from <script> etc.) and strip comments.
  disallowedTagsMode: "discard",
  allowedSchemesAppliedToAttributes: ["href", "src"],
  parser: { lowerCaseAttributeNames: true },
};

/**
 * Truncate to at most `maxBytes` UTF-8 bytes (not UTF-16 code units — multibyte content must not
 * bypass the cap), without splitting a multibyte char. Binary-search the longest char-prefix whose
 * UTF-8 length fits, then back off a trailing lone high surrogate.
 */
function truncateToUtf8Bytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(str.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && lo < str.length) {
    const last = str.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1; // don't end on a lone high surrogate
  }
  return str.slice(0, lo);
}

/**
 * Returns sanitized signature HTML, or "" for null/empty/over-limit input (graceful — an empty
 * signature means "append nothing"). Over-limit input is truncated to the BYTE cap before parse so a
 * huge (or multibyte) paste can't be used as a DoS.
 */
export function sanitizeSignatureHtml(input: string | null | undefined): string {
  if (!input) return "";
  const bounded = truncateToUtf8Bytes(input, MAX_SIGNATURE_HTML_BYTES);
  return sanitizeHtml(bounded, OPTIONS).trim();
}
