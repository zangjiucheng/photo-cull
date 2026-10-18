/// <reference types="vite/client" />

import type { AiRuntimeStatus, PythonCheck, RuntimeSettings, UpdateChannel, UpdateSettings } from "./types";

declare global {
  interface Window {
    aiCulling?: {
      openFolder: () => Promise<string | null>;
      chooseOutputFolder: () => Promise<string | null>;
      openWorkspaceFile: () => Promise<string | null>;
      saveWorkspaceFile: (workspace: { name: string; rootPath: string }) => Promise<string | null>;
      onSaveWorkspaceFileRequest: (callback: () => void) => () => void;
      revealFolder: (folderPath: string) => Promise<boolean>;
      getAiRuntimeStatus: () => Promise<AiRuntimeStatus>;
      installAiRuntime: () => Promise<AiRuntimeStatus>;
      onAiRuntimeStatus: (callback: (status: AiRuntimeStatus) => void) => () => void;
      getRuntimeSettings: () => Promise<RuntimeSettings>;
      checkPython: (command: string | null) => Promise<PythonCheck>;
      setRuntimePython: (command: string | null) => Promise<RuntimeSettings>;
      choosePython: () => Promise<string | null>;
      getUpdateSettings: () => Promise<UpdateSettings>;
      setUpdateChannel: (channel: UpdateChannel) => Promise<UpdateSettings>;
      checkForUpdates: () => Promise<UpdateSettings>;
      onOpenSettingsRequest: (callback: () => void) => () => void;
    };
  }
}

export {};
