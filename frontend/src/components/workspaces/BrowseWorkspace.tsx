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
}

export function BrowseWorkspace(props: BrowseWorkspaceProps) {
  return (
    <div className="workspace-panel browse-workspace">
      <div className="workspace-head">
        <div>
          <span className="panel-kicker">Browse</span>
          <h2>Current Folder</h2>
        </div>
        <button className="link-button" onClick={props.onAddVisibleToQueue}>Add Visible to Queue</button>
      </div>
      <FilterBar {...props} />
      <div className="keep-rate compact-keep-rate">
        <div className="keep-row"><span>Filter retention</span><span>{props.photos.length}/{props.folderPhotosCount}</span></div>
        <div className="progress"><span style={{ width: `${props.keepRate}%` }} /></div>
      </div>
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
