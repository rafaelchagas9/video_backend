import { describe, expect, it } from "bun:test";
import { demoMockService } from "@/utils/demo-mock";
import { creatorListResponseSchema, creatorResponseSchema } from "@/modules/creators/creators.schemas";
import { videoListResponseSchema, videoResponseSchema } from "@/modules/videos/videos.schemas";
import { playlistResponseSchema, playlistListResponseSchema, playlistVideosResponseSchema } from "@/modules/playlists/playlists.schemas";
import { videoCollectionResponseSchema, videoCollectionEntriesResponseSchema } from "@/modules/video-collections/video-collections.schemas";

describe("Demo Mock Service Zod Schema Validation", () => {
  it("validates all getVideos() list elements", () => {
    const list = demoMockService.getVideos({ limit: 100 });
    const parsed = videoListResponseSchema.safeParse({
      success: true,
      data: list.data,
      pagination: list.pagination,
    });
    if (!parsed.success) {
      console.error("Video list parsing failure detail:", JSON.stringify(parsed.error.format(), null, 2));
    }
    expect(parsed.success).toBe(true);
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
        console.error(`Failed on video ID ${item.id}:`, JSON.stringify(parsed.error.format(), null, 2));
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
      console.error("Creator list parsing failure detail:", JSON.stringify(parsed.error.format(), null, 2));
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
        console.error(`Failed on creator ID ${item.id}:`, JSON.stringify(parsed.error.format(), null, 2));
      }
      expect(parsed.success).toBe(true);
    }
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
      expect(videoResponseSchema.safeParse({ success: true, data: detail }).success).toBe(true);

      // Validate favorites list
      const favList = demoMockService.getFavoriteVideos();
      expect(favList.length).toBe(1);
      expect(favList[0].id).toBe(videoId);

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
      expect(creatorResponseSchema.safeParse({ success: true, data: detail }).success).toBe(true);

      demoMockService.removeFavoriteCreator(creatorId);
      expect(demoMockService.isFavoriteCreator(creatorId)).toBe(false);
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
      expect(playlistResponseSchema.safeParse({ success: true, data: playlist }).success).toBe(true);

      // 2. Add video
      const videoId1 = 1;
      const videoId2 = 3;
      demoMockService.addVideoToPlaylist(playlist.id, userId, videoId1);
      demoMockService.addVideoToPlaylist(playlist.id, userId, videoId2);

      // 3. Get playlist videos
      const playlistVideos = demoMockService.getPlaylistVideos(playlist.id, userId);
      expect(playlistVideos.length).toBe(2);
      expect(playlistVideosResponseSchema.safeParse({ success: true, data: playlistVideos }).success).toBe(true);

      // 4. Update and list playlists
      const updated = demoMockService.updatePlaylist(playlist.id, userId, { name: "Updated Name" });
      expect(updated.name).toBe("Updated Name");

      const list = demoMockService.listPlaylists(userId);
      expect(list.length).toBe(1);
      expect(playlistListResponseSchema.safeParse({ success: true, data: list }).success).toBe(true);

      // 5. Remove video
      demoMockService.removeVideoFromPlaylist(playlist.id, userId, videoId1);
      const remainingVideos = demoMockService.getPlaylistVideos(playlist.id, userId);
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
      expect(videoCollectionResponseSchema.safeParse({ success: true, data: collection }).success).toBe(true);

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
      expect(videoCollectionEntriesResponseSchema.safeParse({ success: true, data: entries }).success).toBe(true);

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
      expect(demoMockService.listCollectionEntries(collection.id).length).toBe(1);

      demoMockService.deleteCollection(collection.id);
      expect(() => demoMockService.getCollectionById(collection.id)).toThrow();
    });
  });
});
