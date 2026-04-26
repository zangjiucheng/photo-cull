import { useMemo } from "react";
import type { DecisionFilter, LibraryFolder, Photo, SortMode } from "../types";

interface FilterState {
  activeFolderPath: string;
  search: string;
  minScore: number;
  decisionFilter: DecisionFilter;
  sortMode: SortMode;
  selectedIds: Set<string>;
  rejectedIds: Set<string>;
  activeId: string | null;
}

export function usePhotoFilters(photos: Photo[], folders: LibraryFolder[], state: FilterState) {
  const activeFolder = useMemo(
    () => folders.find((folder) => folder.path === state.activeFolderPath) ?? folders[0] ?? null,
    [folders, state.activeFolderPath]
  );

  const folderPhotos = useMemo(() => {
    if (!activeFolder) {
      return [];
    }
    return photos.filter((photo) => photo.folderPath === activeFolder.path);
  }, [photos, activeFolder]);

  const visiblePhotos = useMemo(() => {
    const items = folderPhotos.filter((photo) => {
      if (photo.aiScore < state.minScore) return false;
      if (state.search && !photo.name.toLowerCase().includes(state.search.toLowerCase())) return false;
      if (state.decisionFilter === "accepted" && !state.selectedIds.has(photo.id)) return false;
      if (state.decisionFilter === "rejected" && !state.rejectedIds.has(photo.id)) return false;
      return true;
    });

    const sorter: Record<SortMode, (a: Photo, b: Photo) => number> = {
      "score-desc": (a, b) => b.aiScore - a.aiScore,
      "score-asc": (a, b) => a.aiScore - b.aiScore,
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "name-desc": (a, b) => b.name.localeCompare(a.name),
      "mtime-desc": (a, b) => b.mtime - a.mtime,
      "mtime-asc": (a, b) => a.mtime - b.mtime
    };

    return [...items].sort(sorter[state.sortMode]);
  }, [folderPhotos, state.decisionFilter, state.minScore, state.rejectedIds, state.search, state.selectedIds, state.sortMode]);

  const activePhoto = useMemo(
    () => photos.find((p) => p.id === state.activeId) ?? visiblePhotos[0] ?? null,
    [photos, state.activeId, visiblePhotos]
  );

  const childFolders = useMemo(
    () => folders.filter((folder) => folder.path.startsWith(state.activeFolderPath ? `${state.activeFolderPath}/` : "") && folder.path !== state.activeFolderPath),
    [folders, state.activeFolderPath]
  );

  return { activeFolder, folderPhotos, visiblePhotos, activePhoto, childFolders };
}
