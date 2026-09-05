import { describe, expect, it } from "bun:test";
import { demoRepository } from "@/database/demo/repository";
import { isDemoAssetPath } from "@/database/demo/assets";
import { useSeededDemoDatabase } from "./helpers/demo-database";
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

useSeededDemoDatabase();

describe("Demo repository response contracts", () => {
  it("rejects asset paths outside demo_mode", () => {
    expect(isDemoAssetPath("demo_mode/video/trailer.webm", "/srv/app")).toBe(
      true
    );
    expect(isDemoAssetPath("demo_mode/../private/video.mp4", "/srv/app")).toBe(
      false
    );
    expect(isDemoAssetPath("/personal/videos/private.mp4", "/srv/app")).toBe(
      false
    );
  });

  it("validates all getVideos() list elements", () => {
    const list = demoRepository.getVideos({ limit: 100 });
    const parsed = videoListResponseSchema.safeParse({
      success: true,
      data: list.data,
      pagination: list.pagination,
    });
    if (!parsed.success) {
      console.error(
        "Video list parsing failure detail:",
        JSON.stringify(parsed.error.format(), null, 2)
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("filters queue video metadata by ID", () => {
    const allVideos = demoRepository.getVideos({ limit: 100 }).data;
    const requestedIds = [allVideos[1]?.id, allVideos[4]?.id].filter(
      (id): id is number => id !== undefined
    );
    const filtered = demoRepository.getVideos({
      ids: requestedIds,
      limit: requestedIds.length,
    });

    expect(
      filtered.data.map((video) => video.id).sort((a, b) => a - b)
    ).toEqual([...requestedIds].sort((a, b) => a - b));
    expect(filtered.pagination.total).toBe(requestedIds.length);
  });

  it("provides enough paginated videos for queue regression testing", () => {
    const firstPage = demoRepository.getVideos({ page: 1, limit: 24 });
    const lastPage = demoRepository.getVideos({ page: 6, limit: 24 });

    expect(firstPage.pagination.total).toBeGreaterThanOrEqual(120);
    expect(firstPage.pagination.totalPages).toBeGreaterThanOrEqual(5);
    expect(firstPage.data).toHaveLength(24);
    expect(lastPage.data.length).toBeGreaterThan(0);
    expect(
      new Set(
        demoRepository.getVideos({ limit: 200 }).data.map((video) => video.id)
      ).size
    ).toBe(firstPage.pagination.total);
  });

  it("validates all getVideos() individual items", () => {
    const list = demoRepository.getVideos({ limit: 100 });
    for (const item of list.data) {
      const detail = demoRepository.getVideoById(item.id);
      const parsed = videoResponseSchema.safeParse({
        success: true,
        data: detail,
      });
      if (!parsed.success) {
        console.error(
          `Failed on video ID ${item.id}:`,
          JSON.stringify(parsed.error.format(), null, 2)
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  it("validates all getCreators() list elements", () => {
    const list = demoRepository.getCreators({ limit: 100 });
    const parsed = creatorListResponseSchema.safeParse({
      success: true,
      data: list.data,
      pagination: list.pagination,
    });
    if (!parsed.success) {
      console.error(
        "Creator list parsing failure detail:",
        JSON.stringify(parsed.error.format(), null, 2)
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("validates all getCreators() individual items", () => {
    const list = demoRepository.getCreators({ limit: 100 });
    for (const item of list.data) {
      const detail = demoRepository.getCreatorById(item.id);
      const parsed = creatorResponseSchema.safeParse({
        success: true,
        data: detail,
      });
      if (!parsed.success) {
        console.error(
          `Failed on creator ID ${item.id}:`,
          JSON.stringify(parsed.error.format(), null, 2)
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  it("provides rich demo metadata, nested tags, and storyboards", () => {
    const creators = demoRepository.getCreators({ limit: 100 }).data;
    expect(
      creators.every(
        (creator) =>
          creator.profile_picture_path &&
          creator.main_picture_path &&
          creator.platforms.length > 0 &&
          creator.social_links.length > 0 &&
          creator.gallery_media.length >= 2
      )
    ).toBe(true);

    const studios = demoRepository.getStudios({ limit: 100 }).data;
    expect(
      studios.every(
        (studio) =>
          studio.profile_picture_path && studio.social_links.length >= 2
      )
    ).toBe(true);

    const tags = demoRepository.getTags();
    const liveSession = tags.find((tag) => tag.name === "Live Session");
    const tinyDesk = tags.find((tag) => tag.name === "Tiny Desk");
    expect(liveSession?.parent_id).not.toBeNull();
    expect(tinyDesk?.parent_id).toBe(liveSession?.id);

    const videos = demoRepository.getVideos({ limit: 100 }).data;
    expect(
      videos.every(
        (video) => video.storyboard?.sprite_path && video.storyboard?.vtt_path
      )
    ).toBe(true);
  });

  // --- Favorites SQLite Tests ---
  describe("SQLite Favorites", () => {
    it("handles favoriting and unfavoriting of videos correctly", () => {
      // Initially not favorited
      const videoId = 1;
      expect(demoRepository.isFavoriteVideo(videoId)).toBe(false);

      // Favorite
      demoRepository.addFavoriteVideo(videoId);
      expect(demoRepository.isFavoriteVideo(videoId)).toBe(true);

      // Validate video detail reflects favorite state
      const detail = demoRepository.getVideoById(videoId);
      expect(detail.is_favorite).toBe(true);
      expect(
        videoResponseSchema.safeParse({ success: true, data: detail }).success
      ).toBe(true);

      // Validate favorites list
      const favList = demoRepository.getFavoriteVideos();
      expect(favList.some((video) => video.id === videoId)).toBe(true);
      expect(
        favoritesListResponseSchema.safeParse({ success: true, data: favList })
          .success
      ).toBe(true);

      // Unfavorite
      demoRepository.removeFavoriteVideo(videoId);
      expect(demoRepository.isFavoriteVideo(videoId)).toBe(false);
      expect(demoRepository.getVideoById(videoId).is_favorite).toBe(false);
    });

    it("handles favoriting and unfavoriting of creators correctly", () => {
      const creatorId = 1;
      expect(demoRepository.isFavoriteCreator(creatorId)).toBe(false);

      demoRepository.addFavoriteCreator(creatorId);
      expect(demoRepository.isFavoriteCreator(creatorId)).toBe(true);

      const detail = demoRepository.getCreatorById(creatorId);
      expect(detail.is_favorite).toBe(true);
      expect(
        creatorResponseSchema.safeParse({ success: true, data: detail }).success
      ).toBe(true);

      demoRepository.removeFavoriteCreator(creatorId);
      expect(demoRepository.isFavoriteCreator(creatorId)).toBe(false);
    });
  });

  describe("SQLite Ratings", () => {
    it("manages ratings in the isolated database", () => {
      const rating = demoRepository.addRating(2, {
        rating: 4,
        comment: "Demo-only rating",
      });

      expect(demoRepository.findRatingById(rating.id)?.rating).toBe(4);
      expect(
        demoRepository
          .getRatingsForVideo(2)
          .some((candidate: any) => candidate.id === rating.id)
      ).toBe(true);

      const updated = demoRepository.updateRating(rating.id, {
        rating: 5,
        comment: "Updated rating",
      });
      expect(updated?.rating).toBe(5);
      expect(updated?.comment).toBe("Updated rating");

      expect(demoRepository.deleteRating(rating.id)).toBe(true);
      expect(demoRepository.findRatingById(rating.id)).toBeNull();
    });
  });

  // --- Playlists SQLite Tests ---
  describe("SQLite Playlists", () => {
    it("manages playlists lifecycle and validates structures", () => {
      const userId = 42;
      const playlistName = "Epic Cinematics";

      // 1. Create playlist
      const playlist = demoRepository.createPlaylist(userId, {
        name: playlistName,
        description: "The best CGI game cinematics",
      });
      expect(playlist.name).toBe(playlistName);
      expect(
        playlistResponseSchema.safeParse({ success: true, data: playlist })
          .success
      ).toBe(true);

      // 2. Add video
      const videoId1 = 1;
      const videoId2 = 3;
      demoRepository.addVideoToPlaylist(playlist.id, userId, videoId1);
      demoRepository.addVideoToPlaylist(playlist.id, userId, videoId2);

      // 3. Get playlist videos
      const playlistVideos = demoRepository.getPlaylistVideos(
        playlist.id,
        userId
      );
      expect(playlistVideos.length).toBe(2);
      expect(
        playlistVideosResponseSchema.safeParse({
          success: true,
          data: playlistVideos,
        }).success
      ).toBe(true);

      // 4. Update and list playlists
      const updated = demoRepository.updatePlaylist(playlist.id, userId, {
        name: "Updated Name",
      });
      expect(updated.name).toBe("Updated Name");

      const list = demoRepository.listPlaylists(userId);
      expect(list.length).toBe(1);
      expect(
        playlistListResponseSchema.safeParse({ success: true, data: list })
          .success
      ).toBe(true);

      // 5. Remove video
      demoRepository.removeVideoFromPlaylist(playlist.id, userId, videoId1);
      const remainingVideos = demoRepository.getPlaylistVideos(
        playlist.id,
        userId
      );
      expect(remainingVideos.length).toBe(1);
      expect(remainingVideos[0].id).toBe(videoId2);

      // 6. Delete playlist
      demoRepository.deletePlaylist(playlist.id, userId);
      expect(() => demoRepository.getPlaylistById(playlist.id)).toThrow();
    });
  });

  // --- Video Collections SQLite Tests ---
  describe("SQLite Video Collections", () => {
    it("manages video collections lifecycle and validates structures", () => {
      const input = {
        title: "Avatar Collection",
        kind: "tv_series" as const,
        description: "Avatar movies and cinematics",
      };

      // 1. Create collection
      const collection = demoRepository.createCollection(input);
      expect(collection.title).toBe(input.title);
      expect(
        videoCollectionResponseSchema.safeParse({
          success: true,
          data: collection,
        }).success
      ).toBe(true);

      // 2. Add entry
      const entry1 = demoRepository.addCollectionEntry(collection.id, {
        video_id: 1,
        entry_kind: "episode",
        sequence_number: 1,
        season_number: 1,
        episode_number: 1,
      });
      demoRepository.addCollectionEntry(collection.id, {
        video_id: 3,
        entry_kind: "episode",
        sequence_number: 2,
        season_number: 1,
        episode_number: 2,
      });
      expect(entry1.video_id).toBe(1);

      // 3. List entries
      const entries = demoRepository.listCollectionEntries(collection.id);
      expect(entries.length).toBe(2);
      expect(
        videoCollectionEntriesResponseSchema.safeParse({
          success: true,
          data: entries,
        }).success
      ).toBe(true);

      // 4. Neighbors and Contexts
      const neighbors = demoRepository.getNeighborsByVideoId(3);
      expect(neighbors).not.toBeNull();
      expect(neighbors!.previous).not.toBeNull();
      expect(neighbors!.previous!.video_id).toBe(1);
      expect(neighbors!.next).toBeNull();

      const context = demoRepository.getCollectionContextByVideoId(1);
      expect(context).not.toBeNull();
      expect(context!.collection_id).toBe(collection.id);

      // 5. Clean up entries and delete collection
      demoRepository.removeCollectionEntry(collection.id, 1);
      expect(demoRepository.listCollectionEntries(collection.id).length).toBe(
        1
      );

      demoRepository.deleteCollection(collection.id);
      expect(() => demoRepository.getCollectionById(collection.id)).toThrow();
    });
  });
});
