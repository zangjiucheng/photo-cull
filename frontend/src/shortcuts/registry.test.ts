import { describe, expect, it } from "vitest";
import { modLabel } from "../lib/platform";
import { shortcutRegistry } from "./registry";
import { modifierMatches } from "./useShortcuts";

const tab = shortcutRegistry.find((shortcut) => shortcut.id === "global.switchTab1")!;
const keys = (pressed: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
  metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...pressed,
});

describe("primary modifier", () => {
  it("labels shortcuts for the current platform", () => {
    expect(tab.label).toBe(`${modLabel}+1`);
  });

  it("is Command on macOS and Control on Windows and Linux", () => {
    expect(modifierMatches(keys({ metaKey: true }), tab, true)).toBe(true);
    expect(modifierMatches(keys({ ctrlKey: true }), tab, true)).toBe(false);
    expect(modifierMatches(keys({ ctrlKey: true }), tab, false)).toBe(true);
    expect(modifierMatches(keys({ metaKey: true }), tab, false)).toBe(false);
  });
});
