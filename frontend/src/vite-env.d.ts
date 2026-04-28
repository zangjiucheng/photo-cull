/// <reference types="vite/client" />

interface Window {
  aiCulling?: {
    openFolder: () => Promise<string | null>;
    openWorkspaceFile: () => Promise<string | null>;
    saveWorkspaceFile: (workspace: { name: string; rootPath: string }) => Promise<string | null>;
    onSaveWorkspaceFileRequest: (callback: () => void) => () => void;
    revealFolder: (folderPath: string) => Promise<boolean>;
  };
}
