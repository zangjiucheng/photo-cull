import type { Photo, RatingFilter, SortMode, ViewMode } from "../../types";
import { FilterBar } from "../library/FilterBar";
import { PhotoGrid } from "../library/PhotoGrid";

interface BrowseWorkspaceProps {
  photos: Photo[];
  folderPhotosCount: number;
  ratings: Map<string, number>;
  activePhotoId: string | null;
  viewMode: ViewMode;
  sortMode: SortMode;
  search: string;
  minScore: number;
  ratingFilter: RatingFilter;
  keepRate: number;
  exportQueueIds: Set<string>;
  onSearchChange: (value: string) => void;
  onMinScoreChange: (value: number) => void;
  onRatingFilterChange: (value: RatingFilter) => void;
  onSortModeChange: (value: SortMode) => void;
  onViewModeChange: (value: ViewMode) => void;
  onSelectPhoto: (id: string) => void;
  onRatePhoto: (id: string, rating: number) => void;
  onAutoRateByScore: () => void;
  onToggleExportQueue: (id: string) => void;
  onAddVisibleToQueue: () => void;
  onRemoveVisibleFromQueue: () => void;
}

export function BrowseWorkspace(props: BrowseWorkspaceProps) {
  return (
    <div className="workspace-panel browse-workspace">
      <FilterBar {...props} visibleCount={props.photos.length} totalCount={props.folderPhotosCount}>
        <button className="link-button" onClick={props.onRemoveVisibleFromQueue}>Unqueue Visible</button>
        <button className="link-button" onClick={props.onAddVisibleToQueue}>Add Visible to Queue</button>
      </FilterBar>
      <div className="browse-content-scroll">
        <PhotoGrid
          photos={props.photos}
          ratings={props.ratings}
          activePhotoId={props.activePhotoId}
          viewMode={props.viewMode}
          exportQueueIds={props.exportQueueIds}
          onSelectPhoto={props.onSelectPhoto}
          onRatePhoto={props.onRatePhoto}
          onToggleExportQueue={props.onToggleExportQueue}
        />
      </div>
    </div>
  );
}
