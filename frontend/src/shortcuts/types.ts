export type ShortcutScope = "global" | "similarity" | "lightbox" | "review";

export interface ShortcutDefinition {
  id: string;
  scope: ShortcutScope;
  key: string;
  label: string;
  description: string;
  category: "Global" | "Similarity" | "Lightbox" | "Review";
  /** Command on macOS, Control elsewhere. */
  modKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  allowRepeat?: boolean;
}

export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

export type ShortcutHandlers = Partial<Record<string, ShortcutHandler>>;
