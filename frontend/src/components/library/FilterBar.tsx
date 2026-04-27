import type { RatingFilter, SortMode, ViewMode } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

interface FilterBarProps {
  search: string;
  minScore: number;
  visibleCount: number;
  totalCount: number;
  keepRate: number;
  ratingFilter: RatingFilter;
  sortMode: SortMode;
  viewMode: ViewMode;
  onSearchChange: (value: string) => void;
  onMinScoreChange: (value: number) => void;
  onRatingFilterChange: (value: RatingFilter) => void;
  onSortModeChange: (value: SortMode) => void;
  onViewModeChange: (value: ViewMode) => void;
  onAutoRateByScore: () => void;
}

export function FilterBar({
  search,
  minScore,
  visibleCount,
  totalCount,
  keepRate,
  ratingFilter,
  sortMode,
  viewMode,
  onSearchChange,
  onMinScoreChange,
  onRatingFilterChange,
  onSortModeChange,
  onViewModeChange,
  onAutoRateByScore
}: FilterBarProps) {
  return (
    <div className="workspace-filterbar">
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <Input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search filename..." className="search-input" />
        {search ? <button className="search-clear" onClick={() => onSearchChange("")}>Clear</button> : null}
      </div>
      <label className="field compact-field">
        <span>AI <strong>{minScore}</strong></span>
        <input type="range" min={0} max={100} value={minScore} onChange={(e) => onMinScoreChange(Number(e.target.value))} />
      </label>
      <Select value={ratingFilter} onChange={(e) => onRatingFilterChange(e.target.value as RatingFilter)} className="decision-filter-select">
        <option value="all">All Stars</option>
        <option value="unrated">Unrated</option>
        <option value="5">5 Stars</option>
        <option value="4">4 Stars</option>
        <option value="3">3 Stars</option>
        <option value="2">2 Stars</option>
        <option value="1">1 Star</option>
      </Select>
      <Select value={sortMode} onChange={(e) => onSortModeChange(e.target.value as SortMode)} className="sort-select">
        <option value="score-desc">Score High</option>
        <option value="score-asc">Score Low</option>
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
        <option value="mtime-desc">Newest</option>
        <option value="mtime-asc">Oldest</option>
      </Select>
      <div className="view-switch" role="tablist" aria-label="View mode">
        <button className={`view-switch-btn ${viewMode === "grid" ? "active" : ""}`.trim()} onClick={() => onViewModeChange("grid")} role="tab" aria-selected={viewMode === "grid"}>Grid</button>
        <button className={`view-switch-btn ${viewMode === "list" ? "active" : ""}`.trim()} onClick={() => onViewModeChange("list")} role="tab" aria-selected={viewMode === "list"}>List</button>
      </div>
      <Button variant="outline" className="toolbar-auto-pick" onClick={onAutoRateByScore}>AI Rate</Button>
      <div className="filter-retention-inline" aria-label="Filter retention">
        <span>Retention</span>
        <strong>{keepRate}%</strong>
        <small>{visibleCount}/{totalCount}</small>
      </div>
    </div>
  );
}
