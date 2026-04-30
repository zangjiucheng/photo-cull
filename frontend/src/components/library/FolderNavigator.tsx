import { useMemo } from "react";
import type { LibraryFolder, Photo } from "../../types";
import { ScrollArea } from "../ui/scroll-area";

interface FolderNavigatorProps {
  folders: LibraryFolder[];
  photos: Photo[];
  activeFolderPath: string;
  activePhotoId: string | null;
  onSelectFolder: (path: string) => void;
  onSelectPhoto: (id: string) => void;
}

interface FolderTreeNode {
  path: string;
  name: string;
  count: number;
  bestScore: number;
  children: FolderTreeNode[];
}

function buildFolderTree(folders: LibraryFolder[]): FolderTreeNode[] {
  const nodeMap = new Map<string, FolderTreeNode>();

  for (const folder of folders) {
    const parts = folder.path ? folder.path.split("/") : [];
    if (!parts.length) {
      nodeMap.set("", { path: "", name: "All Photos", count: folder.count, bestScore: folder.bestScore, children: [] });
      continue;
    }

    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!nodeMap.has(currentPath)) {
        nodeMap.set(currentPath, { path: currentPath, name: part, count: 0, bestScore: 0, children: [] });
      }
    }

    const leaf = nodeMap.get(folder.path);
    if (leaf) {
      leaf.count = folder.count;
      leaf.bestScore = folder.bestScore;
    }
  }

  if (!nodeMap.has("")) {
    nodeMap.set("", { path: "", name: "All Photos", count: 0, bestScore: 0, children: [] });
  }

  const roots: FolderTreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.path === "") {
      roots.push(node);
      continue;
    }
    const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    const parent = nodeMap.get(parentPath);
    if (parent && parent.path !== node.path) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function finalize(node: FolderTreeNode): FolderTreeNode {
    const children = node.children.map(finalize).sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...node,
      children,
      count: node.count || children.reduce((sum, child) => sum + child.count, 0),
      bestScore: node.bestScore || children.reduce((best, child) => Math.max(best, child.bestScore), 0)
    };
  }

  return roots.map(finalize).sort((a, b) => {
    if (a.path === "") return -1;
    if (b.path === "") return 1;
    return a.name.localeCompare(b.name);
  });
}

function findNode(nodes: FolderTreeNode[], path: string): FolderTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function currentFolderName(activeFolderPath: string): string {
  if (!activeFolderPath) return "All Photos";
  const parts = activeFolderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || "All Photos";
}

function fileStatusLabel(photo: Photo): string {
  if (photo.status === "pending") return "Queued";
  if (photo.status === "processing") return "Scoring";
  if (photo.status === "error") return "Error";
  return photo.rating ? `${photo.rating} star${photo.rating === 1 ? "" : "s"}` : "Photo";
}

export function FolderNavigator({
  folders,
  photos,
  activeFolderPath,
  activePhotoId,
  onSelectFolder,
  onSelectPhoto
}: FolderNavigatorProps) {
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const childFolders = useMemo(() => findNode(folderTree, activeFolderPath)?.children ?? [], [activeFolderPath, folderTree]);

  return (
    <div className="folder-navigator">
      <div className="side-panel-head">
        <div>
          <span className="panel-kicker">Folders</span>
          <strong>{currentFolderName(activeFolderPath)}</strong>
        </div>
      </div>
      <div className="folder-path-row" role="navigation" aria-label="Folder path">
        <button className={`path-link ${activeFolderPath === "" ? "active" : ""}`.trim()} onClick={() => onSelectFolder("")}>
          All Photos
        </button>
        {activeFolderPath.split("/").filter(Boolean).map((part, index, parts) => {
          const crumbPath = parts.slice(0, index + 1).join("/");
          return (
            <div key={crumbPath} className="path-segment">
              <span className="path-separator" aria-hidden="true">/</span>
              <button className={`path-link ${crumbPath === activeFolderPath ? "active" : ""}`.trim()} onClick={() => onSelectFolder(crumbPath)}>
                {part}
              </button>
            </div>
          );
        })}
      </div>
      <section className="folder-browser-panel">
        <div className="folder-browser-head">
          <span>Library</span>
          <span>{childFolders.length + photos.length} item(s)</span>
        </div>
        <ScrollArea className="folder-grid-scroll">
          {childFolders.length || photos.length ? (
            <div className="folder-item-grid" role="list" aria-label="Folders and files">
              {childFolders.map((folder) => (
                <button
                  key={folder.path}
                  className="folder-browser-tile folder-tile"
                  onClick={() => onSelectFolder(folder.path)}
                  role="listitem"
                >
                  <span className="folder-tile-thumb" aria-hidden="true">
                    <span className="folder-tile-tab" />
                    <span className="folder-tile-body" />
                  </span>
                  <span className="folder-file-name" title={folder.name}>{folder.name}</span>
                  <span className="folder-file-meta">{folder.count} item(s)</span>
                </button>
              ))}
              {photos.map((photo) => {
                const isActive = activePhotoId === photo.id;
                return (
                  <button
                    key={photo.id}
                    className={`folder-browser-tile folder-file-tile ${isActive ? "active" : ""}`.trim()}
                    data-photo-id={photo.id}
                    onClick={() => onSelectPhoto(photo.id)}
                    aria-current={isActive ? "true" : undefined}
                    role="listitem"
                  >
                    <span className="folder-file-thumb">
                      <img src={photo.url} alt="" loading="lazy" />
                    </span>
                    <span className="folder-file-name" title={photo.name}>{photo.name}</span>
                    <span className="folder-file-meta">{fileStatusLabel(photo)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="folder-file-empty">No files in this folder.</div>
          )}
        </ScrollArea>
      </section>
    </div>
  );
}
