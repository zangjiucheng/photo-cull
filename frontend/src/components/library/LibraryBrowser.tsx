import { useEffect, useMemo, useState } from "react";
import type { DecisionFilter, LibraryFolder, Photo, SimilarGroup, SortMode, StatusTone, ViewMode } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select } from "../ui/select";

interface LibraryBrowserProps {
  folders: LibraryFolder[];
  activeFolder: LibraryFolder | null;
  activeFolderPath: string;
  childFolders: LibraryFolder[];
  visiblePhotos: Photo[];
  selectedIds: Set<string>;
  rejectedIds: Set<string>;
  activePhotoId: string | null;
  viewMode: ViewMode;
  sortMode: SortMode;
  search: string;
  minScore: number;
  decisionFilter: DecisionFilter;
  statusText: string;
  statusTone: StatusTone;
  keepRate: number;
  folderPhotosCount: number;
  similarGroups: SimilarGroup[];
  similarDeleteIds: Set<string>;
  isFindingSimilar: boolean;
  isDeletingSimilar: boolean;
  similarSummary: string;
  onSearchChange: (value: string) => void;
  onMinScoreChange: (value: number) => void;
  onDecisionFilterChange: (value: DecisionFilter) => void;
  onSortModeChange: (value: SortMode) => void;
  onViewModeChange: (value: ViewMode) => void;
  onSelectFolder: (path: string) => void;
  onSelectPhoto: (id: string) => void;
  onToggleAccept: (id: string) => void;
  onToggleReject: (id: string) => void;
  onAutoPickByScore: () => void;
  onFindSimilar: () => void;
  onToggleSimilarDelete: (id: string) => void;
  onDeleteSimilarSelected: () => void;
}

interface FolderTreeNode {
  path: string;
  name: string;
  count: number;
  bestScore: number;
  children: FolderTreeNode[];
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatFolderLabel(folder: LibraryFolder): string {
  return folder.path ? folder.path : "Root";
}

function scoreTone(score: number): string {
  if (score >= 82) return "high";
  if (score >= 70) return "mid";
  return "low";
}

function scoreLabel(photo: Photo): string {
  if (photo.status === "pending") return "Queued";
  if (photo.status === "processing") return "Scoring";
  if (photo.status === "error") return "Error";
  return `Score ${photo.aiScore}`;
}

function buildFolderTree(folders: LibraryFolder[]): FolderTreeNode[] {
  const nodeMap = new Map<string, FolderTreeNode>();

  for (const folder of folders) {
    const parts = folder.path ? folder.path.split("/") : [];
    if (parts.length === 0) {
      if (!nodeMap.has("")) {
        nodeMap.set("", {
          path: "",
          name: "Root",
          count: folder.count,
          bestScore: folder.bestScore,
          children: []
        });
      } else {
        const rootNode = nodeMap.get("");
        if (rootNode) {
          rootNode.count = folder.count;
          rootNode.bestScore = folder.bestScore;
        }
      }
      continue;
    }

    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      if (!nodeMap.has(currentPath)) {
        nodeMap.set(currentPath, {
          path: currentPath,
          name: parts[i],
          count: 0,
          bestScore: 0,
          children: []
        });
      }
    }

    const leafNode = nodeMap.get(folder.path);
    if (leafNode) {
      leafNode.count = folder.count;
      leafNode.bestScore = folder.bestScore;
    }
  }

  const roots: FolderTreeNode[] = [];
  for (const node of nodeMap.values()) {
    const parentPath = node.path.includes("/")
      ? node.path.slice(0, node.path.lastIndexOf("/"))
      : "";

    if (!parentPath) {
      roots.push(node);
      continue;
    }

    const parent = nodeMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function finalize(node: FolderTreeNode): FolderTreeNode {
    const children = node.children
      .map(finalize)
      .sort((a, b) => a.name.localeCompare(b.name));

    const childCount = children.reduce((sum, item) => sum + item.count, 0);
    const childBest = children.reduce((best, item) => Math.max(best, item.bestScore), 0);

    return {
      ...node,
      count: node.count || childCount,
      bestScore: node.bestScore || childBest,
      children
    };
  }

  return roots.map(finalize).sort((a, b) => {
    if (a.path === "") return -1;
    if (b.path === "") return 1;
    return a.name.localeCompare(b.name);
  });
}

export function LibraryBrowser({
  folders,
  activeFolder,
  activeFolderPath,
  childFolders,
  visiblePhotos,
  selectedIds,
  rejectedIds,
  activePhotoId,
  viewMode,
  sortMode,
  search,
  minScore,
  decisionFilter,
  statusText,
  statusTone,
  keepRate,
  folderPhotosCount,
  similarGroups,
  similarDeleteIds,
  isFindingSimilar,
  isDeletingSimilar,
  similarSummary,
  onSearchChange,
  onMinScoreChange,
  onDecisionFilterChange,
  onSortModeChange,
  onViewModeChange,
  onSelectFolder,
  onSelectPhoto,
  onToggleAccept,
  onToggleReject,
  onAutoPickByScore,
  onFindSimilar,
  onToggleSimilarDelete,
  onDeleteSimilarSelected
}: LibraryBrowserProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem("folderTreeExpanded");
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(parsed);
    } catch {
      return new Set();
    }
  });
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  useEffect(() => {
    if (!activeFolderPath) {
      return;
    }

    const parts = activeFolderPath.split("/");
    const next = new Set(expandedPaths);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      next.add(acc);
    }
    setExpandedPaths(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderPath]);

  useEffect(() => {
    window.localStorage.setItem("folderTreeExpanded", JSON.stringify([...expandedPaths]));
  }, [expandedPaths]);

  function toggleExpand(path: string) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderTree(nodes: FolderTreeNode[], depth = 0): JSX.Element[] {
    const result: JSX.Element[] = [];

    for (const node of nodes) {
      const isExpanded = expandedPaths.has(node.path);
      const hasChildren = node.children.length > 0;
      const isActive = node.path === activeFolderPath;

      result.push(
        <div key={node.path}>
          <button
            className={`folder-item tree-item ${isActive ? "active" : ""}`.trim()}
            style={{ paddingLeft: `${10 + depth * 16}px` }}
            onClick={() => onSelectFolder(node.path)}
          >
            <div className="folder-item-content">
              <span
                className={`tree-toggle ${hasChildren ? "is-visible" : ""}`.trim()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (hasChildren) {
                    toggleExpand(node.path);
                  }
                }}
              >
                {hasChildren ? (isExpanded ? "▾" : "▸") : ""}
              </span>
              <span
                className={`folder-icon ${hasChildren ? (isExpanded ? "open" : "closed") : "leaf"}`.trim()}
                aria-hidden="true"
              />
              <div>
                <div className="folder-name">{node.name}</div>
                <div className="folder-meta">{node.count} item(s)</div>
              </div>
            </div>
            <div className="folder-score">{node.bestScore}</div>
          </button>
          {hasChildren && isExpanded ? renderTree(node.children, depth + 1) : null}
          {node.path === activeFolderPath
            ? visiblePhotos.map((photo) => {
              const isPhotoActive = activePhotoId === photo.id;
              return (
                <button
                  key={`file-${photo.id}`}
                  className={`file-item ${isPhotoActive ? "active" : ""}`.trim()}
                  style={{ paddingLeft: `${26 + depth * 16}px` }}
                  onClick={() => onSelectPhoto(photo.id)}
                >
                  <span className="file-icon" aria-hidden="true" />
                  <span className="file-name" title={photo.name}>{photo.name}</span>
                </button>
              );
            })
            : null}
        </div>
      );
    }

    return result;
  }

  return (
    <Card className="library-card">
      <CardHeader className="library-header">
        <div className="library-heading">
          <CardTitle>Library</CardTitle>
          <div className="library-path">{activeFolder ? formatFolderLabel(activeFolder) : "No folder selected"}</div>
        </div>
        <div className="head-tools">
          <Select value={sortMode} onChange={(e) => onSortModeChange(e.target.value as SortMode)} className="sort-select">
            <option value="score-desc">Score: High to Low</option>
            <option value="score-asc">Score: Low to High</option>
            <option value="name-asc">Name: A to Z</option>
            <option value="name-desc">Name: Z to A</option>
            <option value="mtime-desc">Newest First</option>
            <option value="mtime-asc">Oldest First</option>
          </Select>
          <div className="view-switch" role="tablist" aria-label="View mode">
            <button
              className={`view-switch-btn ${viewMode === "grid" ? "active" : ""}`.trim()}
              onClick={() => onViewModeChange("grid")}
              role="tab"
              aria-selected={viewMode === "grid"}
            >
              Grid
            </button>
            <button
              className={`view-switch-btn ${viewMode === "list" ? "active" : ""}`.trim()}
              onClick={() => onViewModeChange("list")}
              role="tab"
              aria-selected={viewMode === "list"}
            >
              List
            </button>
          </div>
          <Badge variant={statusTone === "ok" ? "success" : statusTone === "error" ? "danger" : "secondary"}>{statusText}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="finder-layout">
          <div className="folder-pane">
            <div className="pane-head folder-pane-head">
              <div>
                <div className="pane-title">Folders</div>
                <div className="folder-pane-subtitle">Browse the library tree and jump into active shots.</div>
              </div>
              <div className="folder-pane-badge">{folders.length} folders</div>
            </div>
            <div className="folder-pane-summary">
              <div className="folder-summary-card">
                <span>Current</span>
                <strong>{activeFolder ? activeFolder.name : "Root"}</strong>
              </div>
              <div className="folder-summary-card">
                <span>Visible</span>
                <strong>{visiblePhotos.length}</strong>
              </div>
            </div>
            <div className="folder-path-row" role="navigation" aria-label="Folder path">
              <button
                className={`path-link ${activeFolderPath === "" ? "active" : ""}`.trim()}
                onClick={() => onSelectFolder("")}
              >
                All Photos
              </button>
              {activeFolderPath
                ? activeFolderPath.split("/").map((part, index, parts) => {
                  const crumbPath = parts.slice(0, index + 1).join("/");
                  return (
                    <div key={crumbPath} className="path-segment">
                      <span className="path-separator" aria-hidden="true">/</span>
                      <button
                        className={`path-link ${crumbPath === activeFolderPath ? "active" : ""}`.trim()}
                        onClick={() => onSelectFolder(crumbPath)}
                      >
                        {part}
                      </button>
                    </div>
                  );
                })
                : null}
            </div>
            <ScrollArea className="folder-list">
              {folderTree.length ? renderTree(folderTree, 0) : <div className="folder-empty">No folders with images.</div>}
            </ScrollArea>
          </div>

          <div className="gallery-pane">
            <div className="pane-title">Contents</div>

            <div className="toolbar-grid">
              <div className="search-field">
                <span className="search-icon" aria-hidden="true">⌕</span>
                <Input
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Search filename..."
                  className="search-input"
                />
                {search ? (
                  <button className="search-clear" onClick={() => onSearchChange("")}>Clear</button>
                ) : null}
              </div>
              <label className="field">
                <span>Minimum AI Score <strong>{minScore}</strong></span>
                <input type="range" min={0} max={100} value={minScore} onChange={(e) => onMinScoreChange(Number(e.target.value))} />
              </label>
              <label className="field field-filter">
                <span>Decision Filter</span>
                <Select
                  value={decisionFilter}
                  onChange={(e) => onDecisionFilterChange(e.target.value as DecisionFilter)}
                  className="decision-filter-select"
                >
                  <option value="all">All</option>
                  <option value="accepted">Accepted</option>
                  <option value="rejected">Rejected</option>
                </Select>
              </label>
              <div className="toolbar-actions">
                <Button variant="outline" className="toolbar-auto-pick" onClick={onAutoPickByScore}>AI Pick</Button>
              </div>
            </div>

            <div className="keep-rate">
              <div className="keep-row">
                <span>Keep rate</span>
                <span>{visiblePhotos.length}/{folderPhotosCount}</span>
              </div>
              <div className="progress"><span style={{ width: `${keepRate}%` }} /></div>
              <p>Current folder filtered with your settings.</p>
            </div>

            <section className="similar-panel">
              <div className="similar-panel-head">
                <div>
                  <div className="pane-title">Similar Photos</div>
                  <p>Stage 1 uses pHash for duplicates. Stage 2 uses CLIP + FAISS when available. Best versions are ranked first.</p>
                  {similarSummary ? <p className="similar-summary">{similarSummary}</p> : null}
                </div>
                <div className="similar-actions">
                  <Button variant="outline" onClick={onFindSimilar} disabled={isFindingSimilar}>
                    {isFindingSimilar ? "Finding..." : "Find Similar"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={onDeleteSimilarSelected}
                    disabled={isDeletingSimilar || similarDeleteIds.size === 0}
                  >
                    {isDeletingSimilar ? "Deleting..." : `Delete ${similarDeleteIds.size}`}
                  </Button>
                </div>
              </div>
              {similarGroups.length ? (
                <div className="similar-groups">
                  {similarGroups.map((group, groupIndex) => (
                    <article className="similar-group" key={group.id}>
                      <div className="similar-group-title">
                        <strong>Group {groupIndex + 1}</strong>
                        <span>{group.photos.length} photos · distance {group.maxDistance}</span>
                        <span>{group.stage} · {group.tier}{group.maxSimilarity ? ` · CLIP ${group.maxSimilarity}` : ""}</span>
                      </div>
                      <div className="similar-strip">
                        {group.photos.map((photo, photoIndex) => {
                          const isChecked = similarDeleteIds.has(photo.id);
                          const candidate = group.candidates.find((item) => item.photoId === photo.id);
                          const resolution = candidate ? `${candidate.metadata.width}x${candidate.metadata.height}` : "";
                          return (
                            <article
                              key={photo.id}
                              className={`similar-thumb ${isChecked ? "marked" : ""}`.trim()}
                            >
                              <button className="similar-preview" type="button" onClick={() => onSelectPhoto(photo.id)}>
                                <img src={photo.url} alt={photo.name} loading="lazy" />
                              </button>
                              <span className="similar-rank">{photoIndex === 0 ? "Keep" : "Similar"}</span>
                              <label className="similar-delete">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => onToggleSimilarDelete(photo.id)}
                                />
                                Delete
                              </label>
                              <span className="similar-name" title={photo.name}>{photo.name}</span>
                              <span className="similar-score">Score {photo.aiScore} · {resolution}</span>
                              {candidate ? (
                                <span className="similar-score">
                                  {Math.round(candidate.metadata.fileSize / 1024)} KB
                                  {candidate.metadata.hasGps ? " · GPS" : ""}
                                  {candidate.metadata.takenAt ? ` · ${candidate.metadata.takenAt}` : ""}
                                </span>
                              ) : null}
                            </article>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="similar-empty">No similar groups detected yet.</div>
              )}
            </section>

            <div className={`gallery ${viewMode === "list" ? "list-mode" : ""}`}>
              {!visiblePhotos.length && <div className="empty-gallery">No photos in this folder match the current filters.</div>}
              {visiblePhotos.map((photo) => {
                const isAccepted = selectedIds.has(photo.id);
                const isRejected = rejectedIds.has(photo.id);
                const isActive = (activePhotoId ?? null) === photo.id;
                return (
                  <article
                    key={photo.id}
                    className={`photo-card ${isActive ? "active" : ""}`.trim()}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectPhoto(photo.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectPhoto(photo.id);
                      }
                    }}
                  >
                    <div className="thumb">
                      <img src={photo.url} alt={photo.name} loading="lazy" />
                    </div>
                    <div className="meta">
                      <div className="badges">
                        {isAccepted && <Badge variant="success">Accepted</Badge>}
                        {isRejected && <Badge variant="danger">Rejected</Badge>}
                        <Badge
                          variant={photo.status === "error" ? "danger" : "outline"}
                          className={photo.status === "done" ? scoreTone(photo.aiScore) : ""}
                        >
                          {scoreLabel(photo)}
                        </Badge>
                      </div>
                      <div className="name" title={photo.name}>{photo.name}</div>
                      <div className="meta-row">
                        <div className="decision-actions">
                          <Button variant={isAccepted ? "secondary" : "outline"} size="sm" onClick={() => onToggleAccept(photo.id)}>
                            {isAccepted ? "Accepted" : "Accept"}
                          </Button>
                          <Button variant={isRejected ? "destructive" : "outline"} size="sm" onClick={() => onToggleReject(photo.id)}>
                            {isRejected ? "Rejected" : "Reject"}
                          </Button>
                        </div>
                      </div>
                      <div className="file-extra">
                        <span>{formatBytes(photo.size)}</span>
                        <span>{new Date(photo.mtime * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {childFolders.length > 0 && (
              <div className="subfolder-strip">
                <div className="pane-title">Subfolders</div>
                <div className="subfolder-row">
                  {childFolders.map((folder) => (
                    <button key={folder.path} className="subfolder-card" onClick={() => onSelectFolder(folder.path)}>
                      <div className="subfolder-name">{folder.name}</div>
                      <div className="subfolder-meta">{folder.count} image(s)</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
