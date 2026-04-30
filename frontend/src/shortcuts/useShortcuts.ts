import { useEffect } from "react";
import type { ShortcutDefinition, ShortcutHandlers, ShortcutScope } from "./types";

interface UseShortcutsOptions {
  shortcuts: ShortcutDefinition[];
  handlers: ShortcutHandlers;
  activeScopes: ShortcutScope[];
  disabled?: boolean;
}

const scopePriority: Record<ShortcutScope, number> = {
  lightbox: 0,
  similarity: 1,
  review: 1,
  global: 2
};

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function modifierMatches(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  const allowsShiftAlias = Boolean(shortcut.metaKey) && (shortcut.key === "=" || shortcut.key === "-");
  return Boolean(shortcut.metaKey) === event.metaKey
    && Boolean(shortcut.ctrlKey) === event.ctrlKey
    && Boolean(shortcut.altKey) === event.altKey
    && (Boolean(shortcut.shiftKey) === event.shiftKey || allowsShiftAlias);
}

function keyMatches(event: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  if (shortcut.key === "/" && shortcut.shiftKey && event.key === "?") {
    return true;
  }
  if (shortcut.key === "=" && shortcut.metaKey && (event.key === "=" || event.key === "+")) {
    return true;
  }
  if (shortcut.key === "-" && shortcut.metaKey && (event.key === "-" || event.key === "_")) {
    return true;
  }
  if (shortcut.key.length === 1) {
    return event.key.toLowerCase() === shortcut.key.toLowerCase();
  }
  return event.key === shortcut.key;
}

export function useShortcuts({ shortcuts, handlers, activeScopes, disabled = false }: UseShortcutsOptions) {
  useEffect(() => {
    if (disabled) {
      return;
    }

    const active = new Set(activeScopes);
    const orderedShortcuts = shortcuts
      .filter((shortcut) => active.has(shortcut.scope))
      .sort((a, b) => scopePriority[a.scope] - scopePriority[b.scope]);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      for (const shortcut of orderedShortcuts) {
        if (!shortcut.allowRepeat && event.repeat) {
          continue;
        }
        if (!modifierMatches(event, shortcut) || !keyMatches(event, shortcut)) {
          continue;
        }

        const handled = handlers[shortcut.id]?.(event);
        if (handled === false) {
          continue;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [activeScopes, disabled, handlers, shortcuts]);
}
