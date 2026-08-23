import type { Video } from "@/modules/videos/videos.types";
import type { EnhancedCreator } from "@/modules/creators/creators.types";
import type { EnhancedStudio } from "@/modules/studios/studios.types";
import type { Tag } from "@/modules/tags/tags.types";
import type { VideoCollection } from "@/modules/video-collections/video-collections.types";
import type { Playlist } from "@/modules/playlists/playlists.types";

export interface CrossEntitySearchResult {
  videos: Video[];
  creators: EnhancedCreator[];
  studios: EnhancedStudio[];
  tags: Tag[];
  collections: VideoCollection[];
  playlists: Playlist[];
  totals: {
    videos: number;
    creators: number;
    studios: number;
    tags: number;
    collections: number;
    playlists: number;
  };
}
