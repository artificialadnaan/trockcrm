import { useCallback } from "react";
import { useRouter } from "expo-router";

/**
 * Back, with somewhere to land when there is no history.
 *
 * `router.back()` is a NO-OP when the stack has nothing behind it, and every screen in this app can be
 * reached with an empty stack: a push notification, a deep link, or iOS restoring navigation state after
 * the app is killed. In those cases the Back control renders, is tappable, announces itself to a screen
 * reader — and does nothing at all. A dead control is worse than an absent one, because the user keeps
 * pressing it.
 *
 * Every screen therefore names where Back MEANS to go, and that destination is used whenever there is no
 * history to pop. `replace`, not `push`: the fallback is standing in for a pop, so it must not grow a
 * stack whose own Back button has the same problem one level down.
 *
 * One helper rather than ten call sites. There were ten `router.back()` calls in this app and the
 * review found two of them; the other eight were identical, which is the arithmetic that keeps producing
 * defects here — a fix applied per-site is a fix applied to the sites someone happened to look at.
 */
export type BackNavigator = {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: never) => void;
};

/**
 * The decision, separated from the hook so it can be tested without a renderer — the rest of this
 * suite is pure logic and this is the part that can actually be wrong.
 */
export function goBackOrFallback(router: BackNavigator, fallbackHref: string): void {
  // canGoBack() also returns false before the navigator has mounted, which is exactly when a deep link
  // resolves — so the fallback covers that case too rather than needing its own check.
  if (router.canGoBack()) {
    router.back();
    return;
  }
  // REPLACE, not push: the fallback stands in for a pop, so it must not grow a stack whose own Back
  // has the identical problem one level down.
  router.replace(fallbackHref as never);
}

export function useGoBack(fallbackHref: string) {
  const router = useRouter();
  return useCallback(() => goBackOrFallback(router, fallbackHref), [router, fallbackHref]);
}
