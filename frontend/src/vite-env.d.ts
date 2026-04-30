/// <reference types="vite/client" />

import type { AiRuntimeStatus } from "./types";

declare global {
  interface Window {
    aiCulling?: {
      openFolder: () => Promise<string | null>;
      openWorkspaceFile: () => Promise<string | null>;
      saveWorkspaceFile: (workspace: { name: string; rootPath: string }) => Promise<string | null>;
      onSaveWorkspaceFileRequest: (callback: () => void) => () => void;
      revealFolder: (folderPath: string) => Promise<boolean>;
      getAiRuntimeStatus: () => Promise<AiRuntimeStatus>;
      installAiRuntime: () => Promise<AiRuntimeStatus>;
      onAiRuntimeStatus: (callback: (status: AiRuntimeStatus) => void) => () => void;
    };
  }
}

export {};
