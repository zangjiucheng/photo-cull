import { useMemo } from "react";
import type { LibraryFolder } from "../../types";
import { ScrollArea } from "../ui/scroll-area";

interface FolderNavigatorProps {
  folders: LibraryFolder[];
  activeFolderPath: string;
  visibleCount: number;
  onSelectFolder: (path: string) => void;
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

export function FolderNavigator({ folders, activeFolderPath, visibleCount, onSelectFolder }: FolderNavigatorProps) {
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const columns = useMemo(() => {
    const result: Array<{ title: string; nodes: FolderTreeNode[]; selectedPath: string }> = [
      { title: "Library", nodes: folderTree, selectedPath: activeFolderPath.split("/")[0] || "" }
    ];
    if (!activeFolderPath) return result;

    const parts = activeFolderPath.split("/");
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[index]}` : parts[index];
      const node = findNode(folderTree, currentPath);
      if (node?.children.length) {
        const selectedPath = parts[index + 1] ? `${currentPath}/${parts[index + 1]}` : "";
        result.push({ title: node.name, nodes: node.children, selectedPath });
      }
    }
    return result;
  }, [activeFolderPath, folderTree]);

  return (
    <div className="folder-navigator">
      <div className="side-panel-head">
        <div>
          <span className="panel-kicker">Folders</span>
          <strong>{folders.length} locations</strong>
        </div>
        <span>{visibleCount}</span>
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
      <div className="finder-columns bridge-finder-columns" role="tree" aria-label="Folder columns">
        {columns.map((column, columnIndex) => (
          <section className="finder-column" key={`${column.title}-${columnIndex}`}>
            <div className="finder-column-title">{column.title}</div>
            <ScrollArea className="finder-column-scroll">
              {column.nodes.map((node) => {
                const hasChildren = node.children.length > 0;
                const isActive = node.path === activeFolderPath || node.path === column.selectedPath;
                return (
                  <button
                    key={node.path}
                    className={`finder-folder ${isActive ? "active" : ""}`.trim()}
                    onClick={() => onSelectFolder(node.path)}
                    role="treeitem"
                    aria-selected={node.path === activeFolderPath}
                  >
                    <span className={`folder-icon ${hasChildren ? "closed" : "leaf"}`.trim()} aria-hidden="true" />
                    <span className="finder-folder-copy">
                      <span className="folder-name">{node.name}</span>
                      <span className="folder-meta">{node.count} item(s)</span>
                    </span>
                    <span className="folder-score">{node.bestScore}</span>
                    <span className="finder-chevron" aria-hidden="true">{hasChildren ? ">" : ""}</span>
                  </button>
                );
              })}
            </ScrollArea>
          </section>
        ))}
      </div>
    </div>
  );
}
