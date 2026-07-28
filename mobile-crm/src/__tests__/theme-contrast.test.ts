import { theme } from "../theme/theme";

/**
 * WCAG contrast, computed from the ACTUAL theme tokens.
 *
 * The light theme accumulated three separate accessibility findings for the same root cause: a token
 * named `textMuted` that was ~3.0:1, used as though "muted" meant "allowed to be faint". A name is not a
 * contract. These assertions are, and they read the real values — a token change that drops a pair below
 * its floor fails here rather than in a review round, or in someone's hands on a roof.
 *
 * Floors are WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large/bold text and non-text UI (the brand red
 * is a fill and an accent, never small body copy — see the note on the token).
 */
function channel(component: number): number {
  const c = component / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const c = theme.color;

describe("theme contrast", () => {
  describe.each([
    ["textPrimary", "surface", c.textPrimary, c.surface],
    ["textSecondary", "surface", c.textSecondary, c.surface],
    // The one that has bitten repeatedly. "Muted" is a visual weight, not a licence to fail.
    ["textMuted", "surface", c.textMuted, c.surface],
    ["textMuted", "canvas", c.textMuted, c.canvas],
    ["textMuted", "surfaceMuted", c.textMuted, c.surfaceMuted],
    ["textMuted", "surfaceRaised", c.textMuted, c.surfaceRaised],
    ["textPrimary", "chrome", c.textPrimary, c.chrome],
    ["textSecondary", "chrome", c.textSecondary, c.chrome],
    // Chips and the primary button put white on brand red.
    ["onBrand", "brandRed", c.onBrand, c.brandRed],
    // Status pairs — a tinted chip is useless if its own text fails against its own fill.
    ["amberText", "amberSurface", c.amberText, c.amberSurface],
    ["redText", "redSurface", c.redText, c.redSurface],
    ["greenText", "greenSurface", c.greenText, c.greenSurface],
  ])("%s on %s", (_fgName, _bgName, fg, bg) => {
    it("meets the 4.5:1 floor for normal text", () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe.each([
    ["brandRed", "canvas", c.brandRed, c.canvas],
    ["brandRed", "chrome", c.brandRed, c.chrome],
  ])("%s on %s", (_fgName, _bgName, fg, bg) => {
    it("meets the 3:1 floor for a fill / large-bold accent", () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
    });
  });

  /**
   * PAIRS THE APP ACTUALLY RENDERS — not the pairs the palette intends.
   *
   * The first version of this file asserted `onBrand` on `brandRed` and passed, while every primary
   * button in the app was rendering `textInverse` on `brandRed` at ~3.2:1: login, change password,
   * onboarding, save note, the contacts action, the move commit and the shared formStyles.button. A
   * contrast test that checks the combinations you meant to ship is a test of your intentions.
   *
   * So these are anchored to real call sites. If a control changes which token it uses, this list is
   * wrong and should be updated with it — that is the point, not an inconvenience.
   */
  describe.each([
    // formStyles.button + every screen-level primary action.
    ["textInverse (primary buttons)", "brandRed", c.textInverse, c.brandRed],
    // The active scope pill on the deals and leads lists.
    ["textPrimary (active scope pill)", "surfaceRaised", c.textPrimary, c.surfaceRaised],
    // Heading text on cards — ~17 sites still say inkNavy.
    ["inkNavy (headings)", "surface", c.inkNavy, c.surface],
    ["inkNavy (headings)", "canvas", c.inkNavy, c.canvas],
  ])("%s on %s", (_fgName, _bgName, fg, bg) => {
    it("meets the 4.5:1 floor where it is actually used", () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it("keeps textInverse usable on a brand fill, which is the only place it lands", () => {
    // Stated separately and bluntly because the NAME argues for the opposite value. "Inverse" described
    // the light theme; the usage is "on a filled control", and every such control here is brand red.
    expect(contrastRatio(c.textInverse, c.brandRed)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the surface ladder ordered darkest to lightest", () => {
    // chrome < canvas < surfaceMuted < surface < surfaceRaised. Elevation on a dark UI is carried by
    // this ordering, so a token edited out of sequence makes "raised" read as recessed with no error.
    const ladder = [c.chrome, c.canvas, c.surfaceMuted, c.surface, c.surfaceRaised].map(luminance);
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
  });

  it("rejects a malformed colour rather than scoring it", () => {
    // Guards the helper itself: silently returning 0 for a bad hex would make every assertion above
    // pass for the wrong reason.
    expect(() => contrastRatio("#GGGGGG", c.surface)).toThrow();
  });
});
