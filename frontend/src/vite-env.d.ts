/// <reference types="vite/client" />

interface Window {
  aiCulling?: {
    openFolder: () => Promise<string | null>;
    revealFolder: (folderPath: string) => Promise<boolean>;
  };
}
