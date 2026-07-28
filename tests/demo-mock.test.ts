import { describe, expect, it } from "bun:test";
import { demoMockService, isDemoAssetPath } from "@/utils/demo-mock";
import {
  creatorListResponseSchema,
  creatorResponseSchema,
} from "@/modules/creators/creators.schemas";
import {
  videoListResponseSchema,
  videoResponseSchema,
} from "@/modules/videos/videos.schemas";
import {
  playlistResponseSchema,
  playlistListResponseSchema,
  playlistVideosResponseSchema,
} from "@/modules/playlists/playlists.schemas";
import {
  videoCollectionResponseSchema,
  videoCollectionEntriesResponseSchema,
} from "@/modules/video-collections/video-collections.schemas";
import { favoritesListResponseSchema } from "@/modules/favorites/favorites.schemas";

describe("Demo Mock Service Zod Schema Validation", () => {
  it("rejects asset paths outside demo_mode", () => {
    expect(isDemoAssetPath("demo_mode/video/trailer.webm", "/srv/app")).toBe(
      true,
    );
    expect(isDemoAssetPath("demo_mode/../private/video.mp4", "/srv/app")).toBe(
      false,
    );
    expect(isDemoAssetPath("/personal/videos/private.mp4", "/srv/app")).toBe(
      false,
    );
  });

  it("validates all getVideos() list elements", () => {
    const list = demoMockService.getVideos({ limit: 100 });
    const parsed = videoListResponseSchema.safeParse({
      success: true,
      data: list.data,
      pagination: list.pagination,
    });
    if (!parsed.success) {
      console.error(
        "Video list parsing failure detail:",
        JSON.stringify(parsed.error.format(), null, 2),
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("filters queue video metadata by ID", () => {
    const allVideos = demoMockService.getVideos({ limit: 100 }).data;
    const requestedIds = [allVideos[1]?.id, allVideos[4]?.id].filter(
      (id): id is number => id !== undefined,
    );
    const filtered = demoMockService.getVideos({
      ids: requestedIds,
      limit: requestedIds.length,
    });

    expect(filtered.data.map((video) => video.id).sort((a, b) => a - b)).toEqual(
      [...requestedIds].sort((a, b) => a - b),
    );
    expect(filtered.pagination.total).toBe(requestedIds.length);
  });

  it("validates all getVideos() individual items", () => {
    const list = demoMockService.getVideos({ limit: 100 });
    for (const item of list.data) {
      const detail = demoMockService.getVideoById(item.id);
      const parsed = videoResponseSchema.safeParse({
        success: true,
        data: detail,
      });
      if (!parsed.success) {
        console.error(
          `Failed on video ID ${item.id}:`,
          JSON.stringify(parsed.error.format(), null, 2),
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  it("validates all getCreators() list elements", () => {
    const list = demoMockService.getCreators({ limit: 100 });
    const parsed = creatorListResponseSchema.safeParse({
      success: true,
      data: list.data,
      pagination: list.pagination,
    });
    if (!parsed.success) {
      console.error(
        "Creator list parsing failure detail:",
        JSON.stringify(parsed.error.format(), null, 2),
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("validates all getCreators() individual items", () => {
    const list = demoMockService.getCreators({ limit: 100 });
    for (const item of list.data) {
      const detail = demoMockService.getCreatorById(item.id);
      const parsed = creatorResponseSchema.safeParse({
        success: true,
        data: detail,
      });
      if (!parsed.success) {
        console.error(
          `Failed on creator ID ${item.id}:`,
          JSON.stringify(parsed.error.format(), null, 2),
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  it("provides rich demo metadata, nested tags, and storyboards", () => {
    const creators = demoMockService.getCreators({ limit: 100 }).data;
    expect(
      creators.every(
        (creator) =>
          creator.profile_picture_path &&
          creator.main_picture_path &&
          creator.platforms.length > 0 &&
          creator.social_links.length > 0 &&
          creator.gallery_media.length >= 2,
      ),
    ).toBe(true);

    const studios = demoMockService.getStudios({ limit: 100 }).data;
    expect(
      studios.every(
        (studio) =>
          studio.profile_picture_path && studio.social_links.length >= 2,
      ),
    ).toBe(true);

    const tags = demoMockService.getTags();
    const liveSession = tags.find((tag) => tag.name === "Live Session");
    const tinyDesk = tags.find((tag) => tag.name === "Tiny Desk");
    expect(liveSession?.parent_id).not.toBeNull();
    expect(tinyDesk?.parent_id).toBe(liveSession?.id);

    const videos = demoMockService.getVideos({ limit: 100 }).data;
    expect(
      videos.every(
        (video) => video.storyboard?.sprite_path && video.storyboard?.vtt_path,
      ),
    ).toBe(true);
  });

  // --- Favorites In-Memory Tests ---
  describe("In-Memory Favorites", () => {
    it("handles favoriting and unfavoriting of videos correctly", () => {
      // Initially not favorited
      const videoId = 1;
      expect(demoMockService.isFavoriteVideo(videoId)).toBe(false);

      // Favorite
      demoMockService.addFavoriteVideo(videoId);
      expect(demoMockService.isFavoriteVideo(videoId)).toBe(true);

      // Validate video detail reflects favorite state
      const detail = demoMockService.getVideoById(videoId);
      expect(detail.is_favorite).toBe(true);
      expect(
        videoResponseSchema.safeParse({ success: true, data: detail }).success,
      ).toBe(true);

      // Validate favorites list
      const favList = demoMockService.getFavoriteVideos();
      expect(favList.some((video) => video.id === videoId)).toBe(true);
      expect(
        favoritesListResponseSchema.safeParse({ success: true, data: favList })
          .success,
      ).toBe(true);

      // Unfavorite
      demoMockService.removeFavoriteVideo(videoId);
      expect(demoMockService.isFavoriteVideo(videoId)).toBe(false);
      expect(demoMockService.getVideoById(videoId).is_favorite).toBe(false);
    });

    it("handles favoriting and unfavoriting of creators correctly", () => {
      const creatorId = 1;
      expect(demoMockService.isFavoriteCreator(creatorId)).toBe(false);

      demoMockService.addFavoriteCreator(creatorId);
      expect(demoMockService.isFavoriteCreator(creatorId)).toBe(true);

      const detail = demoMockService.getCreatorById(creatorId);
      expect(detail.is_favorite).toBe(true);
      expect(
        creatorResponseSchema.safeParse({ success: true, data: detail })
          .success,
      ).toBe(true);

      demoMockService.removeFavoriteCreator(creatorId);
      expect(demoMockService.isFavoriteCreator(creatorId)).toBe(false);
    });
  });

  describe("In-Memory Ratings", () => {
    it("manages ratings without persistent storage", () => {
      const rating = demoMockService.addRating(2, {
        rating: 4,
        comment: "Demo-only rating",
      });

      expect(demoMockService.findRatingById(rating.id)?.rating).toBe(4);
      expect(
        demoMockService
          .getRatingsForVideo(2)
          .some((candidate: any) => candidate.id === rating.id),
      ).toBe(true);

      const updated = demoMockService.updateRating(rating.id, {
        rating: 5,
        comment: "Updated in memory",
      });
      expect(updated?.rating).toBe(5);
      expect(updated?.comment).toBe("Updated in memory");

      expect(demoMockService.deleteRating(rating.id)).toBe(true);
      expect(demoMockService.findRatingById(rating.id)).toBeNull();
    });
  });

  // --- Playlists In-Memory Tests ---
  describe("In-Memory Playlists", () => {
    it("manages playlists lifecycle and validates structures", () => {
      const userId = 42;
      const playlistName = "Epic Cinematics";

      // 1. Create playlist
      const playlist = demoMockService.createPlaylist(userId, {
        name: playlistName,
        description: "The best CGI game cinematics",
      });
      expect(playlist.name).toBe(playlistName);
      expect(
        playlistResponseSchema.safeParse({ success: true, data: playlist })
          .success,
      ).toBe(true);

      // 2. Add video
      const videoId1 = 1;
      const videoId2 = 3;
      demoMockService.addVideoToPlaylist(playlist.id, userId, videoId1);
      demoMockService.addVideoToPlaylist(playlist.id, userId, videoId2);

      // 3. Get playlist videos
      const playlistVideos = demoMockService.getPlaylistVideos(
        playlist.id,
        userId,
      );
      expect(playlistVideos.length).toBe(2);
      expect(
        playlistVideosResponseSchema.safeParse({
          success: true,
          data: playlistVideos,
        }).success,
      ).toBe(true);

      // 4. Update and list playlists
      const updated = demoMockService.updatePlaylist(playlist.id, userId, {
        name: "Updated Name",
      });
      expect(updated.name).toBe("Updated Name");

      const list = demoMockService.listPlaylists(userId);
      expect(list.length).toBe(1);
      expect(
        playlistListResponseSchema.safeParse({ success: true, data: list })
          .success,
      ).toBe(true);

      // 5. Remove video
      demoMockService.removeVideoFromPlaylist(playlist.id, userId, videoId1);
      const remainingVideos = demoMockService.getPlaylistVideos(
        playlist.id,
        userId,
      );
      expect(remainingVideos.length).toBe(1);
      expect(remainingVideos[0].id).toBe(videoId2);

      // 6. Delete playlist
      demoMockService.deletePlaylist(playlist.id, userId);
      expect(() => demoMockService.getPlaylistById(playlist.id)).toThrow();
    });
  });

  // --- Video Collections In-Memory Tests ---
  describe("In-Memory Video Collections", () => {
    it("manages video collections lifecycle and validates structures", () => {
      const input = {
        title: "Avatar Collection",
        kind: "tv_series" as const,
        description: "Avatar movies and cinematics",
      };

      // 1. Create collection
      const collection = demoMockService.createCollection(input);
      expect(collection.title).toBe(input.title);
      expect(
        videoCollectionResponseSchema.safeParse({
          success: true,
          data: collection,
        }).success,
      ).toBe(true);

      // 2. Add entry
      const entry1 = demoMockService.addCollectionEntry(collection.id, {
        video_id: 1,
        entry_kind: "episode",
        sequence_number: 1,
        season_number: 1,
        episode_number: 1,
      });
      demoMockService.addCollectionEntry(collection.id, {
        video_id: 3,
        entry_kind: "episode",
        sequence_number: 2,
        season_number: 1,
        episode_number: 2,
      });
      expect(entry1.video_id).toBe(1);

      // 3. List entries
      const entries = demoMockService.listCollectionEntries(collection.id);
      expect(entries.length).toBe(2);
      expect(
        videoCollectionEntriesResponseSchema.safeParse({
          success: true,
          data: entries,
        }).success,
      ).toBe(true);

      // 4. Neighbors and Contexts
      const neighbors = demoMockService.getNeighborsByVideoId(3);
      expect(neighbors).not.toBeNull();
      expect(neighbors!.previous).not.toBeNull();
      expect(neighbors!.previous!.video_id).toBe(1);
      expect(neighbors!.next).toBeNull();

      const context = demoMockService.getCollectionContextByVideoId(1);
      expect(context).not.toBeNull();
      expect(context!.collection_id).toBe(collection.id);

      // 5. Clean up entries and delete collection
      demoMockService.removeCollectionEntry(collection.id, 1);
      expect(demoMockService.listCollectionEntries(collection.id).length).toBe(
        1,
      );

      demoMockService.deleteCollection(collection.id);
      expect(() => demoMockService.getCollectionById(collection.id)).toThrow();
    });
  });
});
