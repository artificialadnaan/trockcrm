import React from "react";
import { render } from "@testing-library/react-native";
import { BrandLogo } from "../BrandLogo";

/** The asset filename behind expo-image's normalized source (jest-expo exposes it as `testUri`). */
function markAsset(image: { props: { source: unknown } }): string {
  const source = image.props.source as Array<{ testUri?: string }>;
  // expo-image normalizes `source` to an ARRAY; core RN <Image> keeps the bare require() value. This is the
  // is-it-expo-image guard — a revert re-introduces the Fabric ImageResponseObserverCoordinator crash, which
  // a bundled require() asset is NOT exempt from (RCTImageManager dispatch_asyncs every request and
  // RCTBundleAssetImageLoader still fires progressHandler).
  expect(Array.isArray(source)).toBe(true);
  return source[0].testUri ?? "";
}

describe("BrandLogo", () => {
  it("renders the mark through expo-image, not core RN <Image>", () => {
    const { getByTestId } = render(<BrandLogo />);
    const image = getByTestId("brand-logo-mark");

    expect(markAsset(image)).toContain("mark");
    // contentFit is expo-image's resizeMode; core <Image> has no such prop.
    expect(image.props.contentFit).toBe("contain");
    // No fade-in where core <Image> had none.
    expect(image.props.transition).toBeNull();
  });

  it("picks the light-surface mark for dark text and the dark-surface mark for light text", () => {
    // `tint` encodes the SURFACE, inverted: "light" text ⇒ dark surface ⇒ mark.png (white accents survive);
    // "dark" text ⇒ light surface ⇒ mark-onlight.png (white accents would otherwise ghost out).
    const onLight = render(<BrandLogo tint="dark" />).getByTestId("brand-logo-mark");
    expect(markAsset(onLight)).toContain("mark-onlight.png");

    const onDark = render(<BrandLogo tint="light" />).getByTestId("brand-logo-mark");
    expect(markAsset(onDark)).toContain("mark.png");
    expect(markAsset(onDark)).not.toContain("onlight");
  });

  it("sizes the mark from the size prop", () => {
    const { getByTestId } = render(<BrandLogo size={32} />);
    expect(getByTestId("brand-logo-mark").props.style).toMatchObject({ width: 32, height: 32 });
  });

  it("announces once as a single grouped image, and hides the wordmark on request", () => {
    const withWordmark = render(<BrandLogo />);
    expect(withWordmark.getByLabelText("T-Rock Cam")).toBeTruthy();
    expect(withWordmark.getByText("T-ROCK")).toBeTruthy();

    const markOnly = render(<BrandLogo showWordmark={false} />);
    expect(markOnly.queryByText("T-ROCK")).toBeNull();
    expect(markOnly.getByTestId("brand-logo-mark")).toBeTruthy();
  });
});
