import { goBackOrFallback } from "../lib/go-back";

function router(canGoBack: boolean) {
  const calls = { back: 0, replace: [] as string[] };
  return {
    nav: {
      canGoBack: () => canGoBack,
      back: () => {
        calls.back += 1;
      },
      replace: (href: never) => {
        calls.replace.push(href as unknown as string);
      },
    },
    calls,
  };
}

/**
 * `router.back()` is a NO-OP on an empty stack, and every screen here is reachable with one: a deep
 * link, a notification, or iOS restoring navigation state after the app is killed. The Back control
 * then renders, is tappable, announces itself to a screen reader — and does nothing. A dead control is
 * worse than an absent one, because the user keeps pressing it.
 */
describe("goBackOrFallback", () => {
  it("pops when there is history", () => {
    const { nav, calls } = router(true);
    goBackOrFallback(nav, "/(app)/deals");
    expect(calls.back).toBe(1);
    expect(calls.replace).toEqual([]);
  });

  it("goes to the named destination when the stack is empty", () => {
    const { nav, calls } = router(false);
    goBackOrFallback(nav, "/(app)/deals");
    expect(calls.back).toBe(0);
    expect(calls.replace).toEqual(["/(app)/deals"]);
  });

  /**
   * REPLACE, not push. A push would leave the destination with nothing behind IT either — the same dead
   * Back one level down, which is the bug rather than a fix for it.
   */
  it("replaces rather than pushes", () => {
    const { nav, calls } = router(false);
    goBackOrFallback(nav, "/(app)/deals/board");
    expect(calls.replace).toHaveLength(1);
  });

  it("covers the pre-mount window too, where canGoBack is also false", () => {
    const { nav, calls } = router(false);
    goBackOrFallback(nav, "/(app)/contacts");
    expect(calls.replace).toEqual(["/(app)/contacts"]);
  });
});
