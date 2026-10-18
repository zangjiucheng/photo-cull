import { modLabel } from "../lib/platform";
import type { ShortcutDefinition, ShortcutScope } from "./types";

export const shortcutRegistry: ShortcutDefinition[] = [
  { id: "global.openPreview", scope: "global", key: " ", label: "Space", description: "Enlarge active photo", category: "Global" },
  { id: "global.toggleQueue", scope: "global", key: "q", label: "Q", description: "Toggle active photo in export queue", category: "Global" },
  { id: "global.showHelp", scope: "global", key: "/", shiftKey: true, label: "Shift+/", description: "Show keyboard shortcuts", category: "Global" },
  ...["Browse", "Review", "Similarity", "Enhance & Export", "Stats", "Settings"].map((label, index) => ({
    id: `global.switchTab${index + 1}`,
    scope: "global" as const,
    key: String(index + 1),
    modKey: true,
    label: `${modLabel}+${index + 1}`,
    description: `Switch to ${label}`,
    category: "Global" as const
  })),
  { id: "global.previousPhoto", scope: "global", key: "h", label: "H", description: "Select photo left", category: "Global" },
  { id: "global.nextPhoto", scope: "global", key: "l", label: "L", description: "Select photo right", category: "Global" },
  { id: "global.photoDown", scope: "global", key: "j", label: "J", description: "Select photo below", category: "Global" },
  { id: "global.photoUp", scope: "global", key: "k", label: "K", description: "Select photo above", category: "Global" },

  { id: "similarity.previous", scope: "similarity", key: "ArrowLeft", label: "←", description: "Previous photo in current similar group", category: "Similarity" },
  { id: "similarity.next", scope: "similarity", key: "ArrowRight", label: "→", description: "Next photo in current similar group", category: "Similarity" },
  { id: "similarity.up", scope: "similarity", key: "ArrowUp", label: "↑", description: "Select photo above in similarity grid", category: "Similarity" },
  { id: "similarity.down", scope: "similarity", key: "ArrowDown", label: "↓", description: "Select photo below in similarity grid", category: "Similarity" },

  { id: "lightbox.close", scope: "lightbox", key: "Escape", label: "Esc", description: "Close enlarged preview", category: "Lightbox" },
  { id: "lightbox.togglePreview", scope: "lightbox", key: " ", label: "Space", description: "Close enlarged preview", category: "Lightbox" },
  { id: "lightbox.previous", scope: "lightbox", key: "ArrowLeft", label: "←", description: "Previous similar photo", category: "Lightbox" },
  { id: "lightbox.next", scope: "lightbox", key: "ArrowRight", label: "→", description: "Next similar photo", category: "Lightbox" },

  { id: "review.toggleQueue", scope: "review", key: "q", label: "Q", description: "Toggle export queue", category: "Review" },
  { id: "review.zoomIn", scope: "review", key: "=", modKey: true, label: `${modLabel}+=`, description: "Zoom in", category: "Review", allowRepeat: true },
  { id: "review.zoomOut", scope: "review", key: "-", modKey: true, label: `${modLabel}+-`, description: "Zoom out", category: "Review", allowRepeat: true },
  { id: "review.resetZoom", scope: "review", key: "0", modKey: true, label: `${modLabel}+0`, description: "Reset zoom", category: "Review" }
];

export function shortcutsForScopes(scopes: ShortcutScope[]): ShortcutDefinition[] {
  const allowed = new Set(scopes);
  return shortcutRegistry.filter((shortcut) => allowed.has(shortcut.scope));
}
