import type { RatingFilter, SortMode, ViewMode } from "../../types";
import type { ReactNode } from "react";
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
  children?: ReactNode;
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
  onAutoRateByScore,
  children
}: FilterBarProps) {
  return (
    <div className="browse-toolbar">
      <div className="workspace-filterbar">
        <div className="search-field">
          <svg className="search-icon" aria-hidden="true" viewBox="0 0 16 16" width="13" height="13">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <Input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search filename..." className="search-input" />
          {search ? <button className="search-clear" onClick={() => onSearchChange("")}>Clear</button> : null}
        </div>
        <label className="field compact-field" title="Minimum AI score">
          <span>AI <strong>{minScore}</strong></span>
          <input type="range" min={0} max={100} value={minScore} onChange={(e) => onMinScoreChange(Number(e.target.value))} />
        </label>
        <Select value={ratingFilter} onChange={(e) => onRatingFilterChange(e.target.value as RatingFilter)} className="decision-filter-select" aria-label="Rating filter">
          <option value="all">All Stars</option>
          <option value="unrated">Unrated</option>
          <option value="5">5 Stars</option>
          <option value="4">4 Stars</option>
          <option value="3">3 Stars</option>
          <option value="2">2 Stars</option>
          <option value="1">1 Star</option>
        </Select>
        <Select value={sortMode} onChange={(e) => onSortModeChange(e.target.value as SortMode)} className="sort-select" aria-label="Sort order">
          <option value="score-desc">Score High</option>
          <option value="score-asc">Score Low</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="mtime-desc">Newest</option>
          <option value="mtime-asc">Oldest</option>
        </Select>
        <div className="view-switch tab-head" role="tablist" aria-label="View mode">
          <button className={`view-switch-btn tab-btn ${viewMode === "grid" ? "active" : ""}`.trim()} onClick={() => onViewModeChange("grid")} role="tab" aria-selected={viewMode === "grid"}>Grid</button>
          <button className={`view-switch-btn tab-btn ${viewMode === "list" ? "active" : ""}`.trim()} onClick={() => onViewModeChange("list")} role="tab" aria-selected={viewMode === "list"}>List</button>
        </div>
      </div>
      <div className="browse-statusbar">
        <div className="filter-retention-inline" aria-label="Filter retention">
          <span className="filter-count">{visibleCount} of {totalCount}</span>
          <span className="filter-dot" aria-hidden="true">·</span>
          <span>Retention</span>
          <strong>{keepRate}%</strong>
        </div>
        <div className="browse-statusbar-actions">
          <button className="link-button toolbar-auto-pick" onClick={onAutoRateByScore}>AI Rate</button>
          {children}
        </div>
      </div>
    </div>
  );
}
