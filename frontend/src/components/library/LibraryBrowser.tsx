import { useMemo } from "react";
import type { LibraryFolder, Photo, RatingFilter, SimilarGroup, SortMode, StatusTone, ViewMode } from "../../types";
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
  visiblePhotos: Photo[];
  ratings: Map<string, number>;
  activePhotoId: string | null;
  viewMode: ViewMode;
  sortMode: SortMode;
  search: string;
  minScore: number;
  ratingFilter: RatingFilter;
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
  onRatingFilterChange: (value: RatingFilter) => void;
  onSortModeChange: (value: SortMode) => void;
  onViewModeChange: (value: ViewMode) => void;
  onSelectFolder: (path: string) => void;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onAutoRateByScore: () => void;
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
  visiblePhotos,
  ratings,
  activePhotoId,
  viewMode,
  sortMode,
  search,
  minScore,
  ratingFilter,
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
  onRatingFilterChange,
  onSortModeChange,
  onViewModeChange,
  onSelectFolder,
  onSelectPhoto,
  onRatePhoto,
  onAutoRateByScore,
  onFindSimilar,
  onToggleSimilarDelete,
  onDeleteSimilarSelected
}: LibraryBrowserProps) {
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const folderColumns = useMemo(() => {
    function findNode(nodes: FolderTreeNode[], path: string): FolderTreeNode | null {
      for (const node of nodes) {
        if (node.path === path) {
          return node;
        }
        const child = findNode(node.children, path);
        if (child) {
          return child;
        }
      }
      return null;
    }

    const columns: Array<{ title: string; nodes: FolderTreeNode[]; selectedPath: string }> = [
      { title: "Library", nodes: folderTree, selectedPath: activeFolderPath.split("/")[0] || "" }
    ];
    if (!activeFolderPath) {
      return columns;
    }

    const parts = activeFolderPath.split("/");
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[index]}` : parts[index];
      const node = findNode(folderTree, currentPath);
      if (node && node.children.length) {
        const nextSelectedPath = parts[index + 1] ? `${currentPath}/${parts[index + 1]}` : "";
        columns.push({ title: node.name, nodes: node.children, selectedPath: nextSelectedPath });
      }
    }
    return columns;
  }, [activeFolderPath, folderTree]);

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
            <div className="finder-columns" role="tree" aria-label="Folder columns">
              {folderColumns.map((column, columnIndex) => (
                <section className="finder-column" key={`${column.title}-${columnIndex}`}>
                  <div className="finder-column-title">{column.title}</div>
                  <ScrollArea className="finder-column-scroll">
                    {column.nodes.length ? column.nodes.map((node) => {
                      const isActive = node.path === activeFolderPath;
                      const isSelectedInColumn = node.path === column.selectedPath;
                      const hasChildren = node.children.length > 0;
                      return (
                        <button
                          key={node.path}
                          className={`finder-folder ${isActive || isSelectedInColumn ? "active" : ""}`.trim()}
                          onClick={() => onSelectFolder(node.path)}
                          role="treeitem"
                          aria-selected={isActive}
                        >
                          <span className={`folder-icon ${hasChildren ? "closed" : "leaf"}`.trim()} aria-hidden="true" />
                          <span className="finder-folder-copy">
                            <span className="folder-name">{node.name}</span>
                            <span className="folder-meta">{node.count} item(s)</span>
                          </span>
                          <span className="folder-score">{node.bestScore}</span>
                          <span className="finder-chevron" aria-hidden="true">{hasChildren ? "›" : ""}</span>
                        </button>
                      );
                    }) : <div className="folder-empty">No folders here.</div>}
                  </ScrollArea>
                </section>
              ))}
            </div>
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
                <span>Rating Filter</span>
                <Select
                  value={ratingFilter}
                  onChange={(e) => onRatingFilterChange(e.target.value as RatingFilter)}
                  className="decision-filter-select"
                >
                  <option value="all">All</option>
                  <option value="unrated">Unrated</option>
                  <option value="5">5 Stars</option>
                  <option value="4">4 Stars</option>
                  <option value="3">3 Stars</option>
                  <option value="2">2 Stars</option>
                  <option value="1">1 Star</option>
                </Select>
              </label>
              <div className="toolbar-actions">
                <Button variant="outline" className="toolbar-auto-pick" onClick={onAutoRateByScore}>AI Rate</Button>
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
                  <p>Stage 1 uses pHash for exact matches. Stage 2 uses CLIP + FAISS when available. Best versions are ranked first.</p>
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
                const rating = ratings.get(photo.id) ?? photo.rating ?? 0;
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
                        {rating > 0 && <Badge variant="success">{rating} ★</Badge>}
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
                          <div className="star-rating star-rating-compact">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                key={star}
                                type="button"
                                className={`star-btn ${rating >= star ? "filled" : ""}`.trim()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onRatePhoto(photo.id, star);
                                }}
                                aria-label={`Set ${star} star${star === 1 ? "" : "s"} for ${photo.name}`}
                              >
                                ★
                              </button>
                            ))}
                          </div>
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
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
