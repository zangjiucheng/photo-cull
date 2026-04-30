import { useEffect } from "react";
import type { ShortcutDefinition, ShortcutScope } from "./types";
import { shortcutsForScopes } from "./registry";

interface ShortcutHelpDialogProps {
  open: boolean;
  scopes: ShortcutScope[];
  onClose: () => void;
}

export function ShortcutHelpDialog({ open, scopes, onClose }: ShortcutHelpDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const shortcuts = shortcutsForScopes(scopes);
  const categories = Array.from(new Set(shortcuts.map((shortcut) => shortcut.category)));

  return (
    <div className="shortcut-help-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}>
      <section className="shortcut-help-panel" onClick={(event) => event.stopPropagation()}>
        <div className="shortcut-help-head">
          <div>
            <span className="panel-kicker">Keyboard</span>
            <h2>Shortcuts</h2>
          </div>
          <button className="shortcut-help-close" type="button" onClick={onClose} aria-label="Close shortcuts">×</button>
        </div>
        <div className="shortcut-help-groups">
          {categories.map((category) => (
            <div className="shortcut-help-group" key={category}>
              <h3>{category}</h3>
              {shortcuts.filter((shortcut) => shortcut.category === category).map((shortcut: ShortcutDefinition) => (
                <div className="shortcut-help-row" key={shortcut.id}>
                  <kbd>{shortcut.label}</kbd>
                  <span>{shortcut.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
