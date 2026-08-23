import { videosSearchService } from "@/modules/videos/videos.search.service";
import { creatorsService } from "@/modules/creators/creators.service";
import { studiosService } from "@/modules/studios/studios.service";
import { tagsService } from "@/modules/tags/tags.service";
import { videoCollectionsService } from "@/modules/video-collections/video-collections.service";
import { playlistsService } from "@/modules/playlists/playlists.service";
import type { CrossEntitySearchResult } from "./search.types";

export class SearchService {
  async search(
    userId: number,
    query: string,
    limit: number
  ): Promise<CrossEntitySearchResult> {
    const [videos, creators, studios, tags, allCollections, allPlaylists] =
      await Promise.all([
        videosSearchService.list(userId, { page: 1, limit, search: query }),
        creatorsService.list({ page: 1, limit, search: query }, userId),
        studiosService.list({ page: 1, limit, search: query }),
        tagsService.list({ page: 1, limit, search: query }),
        videoCollectionsService.list(userId),
        playlistsService.list(userId),
      ]);

    const needle = query.toLocaleLowerCase();
    const collections = allCollections.filter((collection) =>
      [collection.title, collection.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle))
    );
    const playlists = allPlaylists.filter((playlist) =>
      [playlist.name, playlist.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle))
    );

    return {
      videos: videos.data,
      creators: creators.data,
      studios: studios.data,
      tags: tags.data.slice(0, limit),
      collections: collections.slice(0, limit),
      playlists: playlists.slice(0, limit),
      totals: {
        videos: videos.pagination.total,
        creators: creators.pagination.total,
        studios: studios.pagination.total,
        tags: tags.pagination.total,
        collections: collections.length,
        playlists: playlists.length,
      },
    };
  }
}

export const searchService = new SearchService();
