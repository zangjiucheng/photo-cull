// The primary shortcut modifier is Command on macOS and Control on Windows and Linux.
const platformName =
  typeof navigator === "undefined"
    ? ""
    : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent);

export const isMac = /mac|iphone|ipad/i.test(platformName);
export const modLabel = isMac ? "Cmd" : "Ctrl";
/** Prefix for compact hints: "⌘Z" on macOS, "Ctrl+Z" elsewhere. */
export const modPrefix = isMac ? "⌘" : "Ctrl+";
export const shiftModPrefix = isMac ? "⇧⌘" : "Ctrl+Shift+";

export function hasModKey(event: { metaKey: boolean; ctrlKey: boolean }) {
  return isMac ? event.metaKey : event.ctrlKey;
}
