import { Linking } from "react-native";

/**
 * Open a tel:/sms:/mailto: URL, reporting failure instead of swallowing it.
 *
 * `Linking.openURL(url).catch(() => undefined)` is a success-looking failure: the rep taps Call, nothing
 * happens, and there is no way to tell a missing dialer or a malformed number from a slow one. This app
 * already refuses that pattern elsewhere — a silent watch toggle was fixed for the same reason — so it
 * should not survive here just because the failure is rarer.
 *
 * `report` receives a message fit to show a user, or NULL on success. Reporting the success case is
 * what stops a one-off failure from sticking: a transient OS handoff failure would otherwise leave the
 * button reading "Can't call" forever, including after a retry that plainly worked.
 */
export async function openLink(
  url: string,
  report: (message: string | null) => void,
): Promise<void> {
  try {
    await Linking.openURL(url);
    report(null);
  } catch {
    // The scheme tells us which app was missing, which is the only actionable part.
    const kind = url.startsWith("tel:")
      ? "call"
      : url.startsWith("sms:")
        ? "text"
        : url.startsWith("mailto:")
          ? "email"
          : "open";
    report(`Couldn't ${kind} from this device.`);
  }
}
