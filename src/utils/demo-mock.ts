import { readFileSync, realpathSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { API_PREFIX } from "@/config/constants";
import { logger } from "@/utils/logger";

export function isDemoAssetPath(value: unknown, cwd = process.cwd()): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  const demoRoot = resolve(cwd, "demo_mode");
  const targetPath = resolve(cwd, value);
  return targetPath.startsWith(`${demoRoot}${sep}`);
}

export class DemoMockService {
  private data: any = null;
  private tags: any[] = [];
  private studios: any[] = [];
  private creators: any[] = [];
  private videos: any[] = [];

  // In-memory databases for Demo Mode persistence
  private favoritedVideoIds: Set<number> = new Set();
  private favoritedVideoAddedAt: Map<number, string> = new Map();
  private favoritedCreatorIds: Set<number> = new Set();
  private playlists: Map<number, any> = new Map();
  private collections: Map<number, any> = new Map();
  private collectionEntries: Map<number, any> = new Map();
  private dataModifiedAtMs = 0;
  private nextPlaylistId = 1;
  private nextCollectionId = 1;
  private nextCollectionEntryId = 1;
  private nextBookmarkId = 1_000_001;
  private nextRatingId = 1_000_001;
  private demoLibrarySeeded = false;

  constructor() {
    this.loadData();
  }

  private assertDemoAssetPath(value: unknown, label: string) {
    if (value === null || value === undefined) {
      return;
    }
    if (!isDemoAssetPath(value)) {
      throw new Error(`Demo asset path escapes demo_mode for ${label}`);
    }

    const demoRoot = realpathSync(resolve(process.cwd(), "demo_mode"));
    const targetPath = realpathSync(resolve(process.cwd(), value as string));
    if (!targetPath.startsWith(`${demoRoot}${sep}`)) {
      throw new Error(`Demo asset symlink escapes demo_mode for ${label}`);
    }
  }

  private validateAssetPaths(data: any) {
    for (const [studioIndex, studio] of (data.studios || []).entries()) {
      this.assertDemoAssetPath(
        studio.profilePicturePath,
        `studios[${studioIndex}].profilePicturePath`,
      );
    }

    for (const [creatorIndex, creator] of (data.creators || []).entries()) {
      this.assertDemoAssetPath(
        creator.profilePicturePath,
        `creators[${creatorIndex}].profilePicturePath`,
      );
      this.assertDemoAssetPath(
        creator.mainPicturePath,
        `creators[${creatorIndex}].mainPicturePath`,
      );
      this.assertDemoAssetPath(
        creator.faceThumbnailPath,
        `creators[${creatorIndex}].faceThumbnailPath`,
      );
      for (const [galleryIndex, media] of (
        creator.galleryMedia || []
      ).entries()) {
        this.assertDemoAssetPath(
          media.filePath,
          `creators[${creatorIndex}].galleryMedia[${galleryIndex}].filePath`,
        );
      }
    }

    for (const [videoIndex, video] of (data.videos || []).entries()) {
      this.assertDemoAssetPath(
        video.filePath,
        `videos[${videoIndex}].filePath`,
      );
      this.assertDemoAssetPath(
        video.thumbnail?.filePath,
        `videos[${videoIndex}].thumbnail.filePath`,
      );
      this.assertDemoAssetPath(
        video.storyboard?.spritePath,
        `videos[${videoIndex}].storyboard.spritePath`,
      );
      this.assertDemoAssetPath(
        video.storyboard?.vttPath,
        `videos[${videoIndex}].storyboard.vttPath`,
      );
    }
  }

  private loadData() {
    const jsonPath = join(process.cwd(), "demo_mode", "demo_mode.json");
    try {
      const modifiedAtMs = statSync(jsonPath).mtimeMs;
      if (this.data && modifiedAtMs <= this.dataModifiedAtMs) {
        return;
      }

      const raw = readFileSync(jsonPath, "utf-8");
      this.data = JSON.parse(raw);
      this.validateAssetPaths(this.data);
      this.dataModifiedAtMs = modifiedAtMs;

      // 1. Map Tags
      this.tags = (this.data.tags || []).map((t: any, idx: number) => ({
        id: idx + 1,
        name: t.name,
        parent_id: null,
        parentName: t.parentName,
        description: t.description || null,
        color: t.color || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      // Resolve parent IDs for tags
      for (const tag of this.tags) {
        if (tag.parentName) {
          const parent = this.tags.find((p) => p.name === tag.parentName);
          if (parent) {
            tag.parent_id = parent.id;
          }
        }
      }

      // 2. Map Studios
      this.studios = (this.data.studios || []).map((s: any, idx: number) => ({
        id: idx + 1,
        name: s.name,
        description: s.description || null,
        profile_picture_path: s.profilePicturePath || null,
        profile_picture_url: s.profilePicturePath
          ? `/api/studios/${idx + 1}/picture`
          : undefined,
        social_links: (s.socialLinks || []).map(
          (socialLink: any, socialLinkIndex: number) => ({
            id: socialLinkIndex + 1,
            studio_id: idx + 1,
            platform_name: socialLink.platformName,
            url: socialLink.url,
            created_at: new Date().toISOString(),
          }),
        ),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      // 3. Map Creators
      this.creators = (this.data.creators || []).map((c: any, idx: number) => ({
        id: idx + 1,
        name: c.name,
        description: c.description || null,
        profile_picture_path: c.profilePicturePath || null,
        main_picture_path: c.mainPicturePath || null,
        face_thumbnail_path: c.faceThumbnailPath || null,
        profile_picture_url: c.profilePicturePath
          ? `/api/creators/${idx + 1}/picture`
          : undefined,
        main_picture_url: c.mainPicturePath
          ? `/api/creators/${idx + 1}/picture?variant=main`
          : undefined,
        face_thumbnail_url: c.faceThumbnailPath
          ? `/api/creators/${idx + 1}/picture?type=face`
          : undefined,
        aliases: (c.aliases || []).map((aliasName: string, aIdx: number) => ({
          id: aIdx + 1,
          creator_id: idx + 1,
          name: aliasName,
          note: null,
          created_at: new Date().toISOString(),
        })),
        platforms: (c.platforms || []).map((p: any, pIdx: number) => ({
          id: pIdx + 1,
          creator_id: idx + 1,
          platform_id: pIdx + 1,
          platform_name: p.platformName,
          username: p.username,
          profile_url: p.profileUrl,
          is_primary: p.isPrimary || false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
        social_links: (c.socialLinks || []).map((sl: any, slIdx: number) => ({
          id: slIdx + 1,
          creator_id: idx + 1,
          platform_name: sl.platformName,
          url: sl.url,
          created_at: new Date().toISOString(),
        })),
        gallery_media: (c.galleryMedia || []).map((gm: any, gmIdx: number) => ({
          id: gmIdx + 1,
          creator_id: idx + 1,
          label: gm.label || null,
          description: gm.description || null,
          file_path: gm.filePath,
          is_profile_picture: gm.filePath === c.profilePicturePath,
          is_main_picture: gm.filePath === c.mainPicturePath,
          url: `/api/creators/${idx + 1}/gallery/${gmIdx + 1}/image`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
        face_embeddings: c.faceEmbeddings || [],
        is_favorite: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      // 4. Map Videos
      this.videos = (this.data.videos || []).map((v: any, idx: number) => {
        const videoId = idx + 1;

        const videoCreators = (v.creators || []).map((name: string) => {
          const creator = this.creators.find((c) => c.name === name);
          return creator
            ? creator
            : {
                id: 999,
                name,
                description: null,
                profile_picture_path: null,
                face_thumbnail_path: null,
                profile_picture_url: undefined,
                face_thumbnail_url: undefined,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
        });

        const videoStudios = (v.studios || []).map((name: string) => {
          const studio = this.studios.find((s) => s.name === name);
          return studio
            ? studio
            : {
                id: 999,
                name,
                description: null,
                profile_picture_path: null,
                profile_picture_url: undefined,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
        });

        const videoTags = (v.tags || []).map((name: string) => {
          const tag = this.tags.find((t) => t.name === name);
          return tag
            ? tag
            : {
                id: 999,
                name,
                parent_id: null,
                description: null,
                color: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
        });

        return {
          id: videoId,
          file_path: v.filePath,
          file_name: v.fileName,
          directory_id: 1,
          file_size_bytes: v.fileSizeBytes,
          file_hash: v.fileHash || null,
          duration_seconds:
            v.durationSeconds !== undefined ? v.durationSeconds : null,
          width: v.width || null,
          height: v.height || null,
          codec: v.codec || null,
          bitrate: v.bitrate || null,
          fps: v.fps || null,
          audio_codec: v.audioCodec || null,
          title: v.title || null,
          description: v.description || null,
          themes: v.themes || null,
          is_available: true,
          is_favorite: false,
          last_verified_at: null,
          indexed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          thumbnail_id: v.thumbnail ? videoId : null,
          thumbnail_url: v.thumbnail
            ? `${API_PREFIX}/thumbnails/${videoId}/image`
            : null,
          thumbnail: v.thumbnail
            ? {
                id: videoId,
                video_id: videoId,
                file_path: v.thumbnail.filePath,
                file_size_bytes: 1024,
                timestamp_seconds: v.thumbnail.timestampSeconds,
                width: v.thumbnail.width,
                height: v.thumbnail.height,
                generated_at: new Date().toISOString(),
              }
            : null,
          storyboard: v.storyboard
            ? {
                id: videoId,
                video_id: videoId,
                sprite_path: v.storyboard.spritePath,
                vtt_path: v.storyboard.vttPath,
                tile_width: v.storyboard.tileWidth,
                tile_height: v.storyboard.tileHeight,
                tile_count: v.storyboard.tileCount,
                interval_seconds: v.storyboard.intervalSeconds,
                sprite_size_bytes: 2048,
                generated_at: new Date().toISOString(),
              }
            : null,
          creators: videoCreators,
          studios: videoStudios,
          tags: videoTags,
          ratings: (v.ratings || []).map(
            (rating: any, ratingIndex: number) => ({
              id: videoId * 1_000 + ratingIndex + 1,
              video_id: videoId,
              rating: rating.rating,
              comment: rating.comment || null,
              rated_at: rating.ratedAt || new Date().toISOString(),
            }),
          ),
          bookmarks: (v.bookmarks || []).map(
            (bookmark: any, bookmarkIndex: number) => ({
              id: videoId * 1_000 + bookmarkIndex + 1,
              video_id: videoId,
              user_id: 1,
              timestamp_seconds: bookmark.timestampSeconds,
              name: bookmark.name,
              description: bookmark.description || null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          ),
          stats: v.stats || {
            playCount: 0,
            totalWatchSeconds: 0,
            lastPositionSeconds: 0,
          },
        };
      });

      this.seedDemoLibraryData();
    } catch (error) {
      this.data = { tags: [], studios: [], creators: [], videos: [] };
      this.tags = [];
      this.studios = [];
      this.creators = [];
      this.videos = [];
      logger.error({ error }, "Error loading demo mode JSON data");
    }
  }

  private seedDemoLibraryData() {
    if (this.demoLibrarySeeded || this.videos.length === 0) {
      return;
    }

    const createdAt = new Date().toISOString();
    const demoUserId = 1;
    const existingVideoIds = new Set(this.videos.map((video) => video.id));

    const seedPlaylist = (
      name: string,
      description: string,
      videoIds: number[],
    ) => {
      const filteredVideoIds = videoIds.filter((id) =>
        existingVideoIds.has(id),
      );
      if (filteredVideoIds.length === 0) {
        return;
      }

      const id = this.nextPlaylistId++;
      this.playlists.set(id, {
        id,
        user_id: demoUserId,
        name,
        description,
        created_at: createdAt,
        updated_at: createdAt,
        videoIds: filteredVideoIds,
      });
    };

    const seedFavoriteVideo = (videoId: number) => {
      if (!existingVideoIds.has(videoId)) {
        return;
      }

      this.favoritedVideoIds.add(videoId);
      this.favoritedVideoAddedAt.set(videoId, createdAt);
    };

    const seedCollection = (
      title: string,
      kind: string,
      description: string,
      entries: Array<{
        videoId: number;
        entryKind: string;
        sequenceNumber: number;
        seasonNumber?: number | null;
        episodeNumber?: number | null;
      }>,
      releaseYear: number | null = null,
    ) => {
      const filteredEntries = entries.filter((entry) =>
        existingVideoIds.has(entry.videoId),
      );
      if (filteredEntries.length === 0) {
        return;
      }

      const collectionId = this.nextCollectionId++;
      this.collections.set(collectionId, {
        id: collectionId,
        title,
        kind,
        description,
        release_year: releaseYear,
        external_ids_json: null,
        created_at: createdAt,
        updated_at: createdAt,
      });

      for (const entry of filteredEntries) {
        const id = this.nextCollectionEntryId++;
        this.collectionEntries.set(id, {
          id,
          collectionId,
          videoId: entry.videoId,
          entryKind: entry.entryKind,
          sequenceNumber: entry.sequenceNumber,
          seasonNumber: entry.seasonNumber ?? null,
          episodeNumber: entry.episodeNumber ?? null,
          episodePart: null,
          absoluteNumber: entry.sequenceNumber,
          displayTitleOverride: null,
          created_at: createdAt,
          updated_at: createdAt,
        });
      }
    };

    seedPlaylist(
      "Cinematic Showcase",
      "Demo playlist with action-heavy game cinematics.",
      [1, 3, 4],
    );
    seedPlaylist(
      "Trailer Queue",
      "Demo playlist with upcoming movie and animation trailers.",
      [5, 6, 7, 8],
    );
    seedFavoriteVideo(5);
    seedFavoriteVideo(7);
    seedFavoriteVideo(8);

    seedCollection(
      "Overwatch Animated Shorts",
      "anthology",
      "Demo anthology of animated shorts.",
      [
        {
          videoId: 2,
          entryKind: "episode",
          sequenceNumber: 1,
          seasonNumber: 1,
          episodeNumber: 1,
        },
        {
          videoId: 4,
          entryKind: "episode",
          sequenceNumber: 2,
          seasonNumber: 1,
          episodeNumber: 2,
        },
      ],
    );
    seedCollection(
      "Demo Trailer Collection",
      "movie_series",
      "Demo collection of related trailer content.",
      [
        {
          videoId: 5,
          entryKind: "movie",
          sequenceNumber: 1,
        },
        {
          videoId: 7,
          entryKind: "movie",
          sequenceNumber: 2,
        },
        {
          videoId: 8,
          entryKind: "special",
          sequenceNumber: 3,
        },
      ],
    );

    this.demoLibrarySeeded = true;
  }

  // --- Video Methods ---
  getVideos(options: any = {}) {
    this.loadData();
    let list = [...this.videos];

    if (options.ids && options.ids.length > 0) {
      const ids = Array.isArray(options.ids)
        ? options.ids.map(Number)
        : [Number(options.ids)];
      list = list.filter((video) => ids.includes(video.id));
    }

    // Search filtering
    if (options.search) {
      const s = options.search.toLowerCase();
      list = list.filter(
        (v) =>
          v.title.toLowerCase().includes(s) ||
          v.description.toLowerCase().includes(s) ||
          (v.themes && v.themes.toLowerCase().includes(s)),
      );
    }

    if (options.tagIds && options.tagIds.length > 0) {
      const tagIds = Array.isArray(options.tagIds)
        ? options.tagIds.map(Number)
        : [Number(options.tagIds)];
      list = list.filter((v) => v.tags.some((t: any) => tagIds.includes(t.id)));
    }

    if (options.creatorIds && options.creatorIds.length > 0) {
      const creatorIds = Array.isArray(options.creatorIds)
        ? options.creatorIds.map(Number)
        : [Number(options.creatorIds)];
      list = list.filter((v) =>
        v.creators.some((c: any) => creatorIds.includes(c.id)),
      );
    }

    if (options.studioIds && options.studioIds.length > 0) {
      const studioIds = Array.isArray(options.studioIds)
        ? options.studioIds.map(Number)
        : [Number(options.studioIds)];
      list = list.filter((v) =>
        v.studios.some((s: any) => studioIds.includes(s.id)),
      );
    }

    if (options.createdFrom) {
      const createdFrom = new Date(options.createdFrom).getTime();
      list = list.filter(
        (video) => new Date(video.created_at).getTime() >= createdFrom,
      );
    }

    if (options.createdBefore) {
      const createdBefore = new Date(options.createdBefore).getTime();
      list = list.filter(
        (video) => new Date(video.created_at).getTime() < createdBefore,
      );
    }

    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = list.slice((page - 1) * limit, page * limit).map((v) => ({
      ...v,
      is_favorite: this.isFavoriteVideo(v.id),
      collection: this.getCollectionContextByVideoId(v.id),
    }));

    return {
      data: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  getVideoById(id: number) {
    this.loadData();
    const video = this.videos.find((v) => v.id === id);
    if (!video) throw new Error(`Video not found with id: ${id}`);

    return {
      ...video,
      is_favorite: this.isFavoriteVideo(video.id),
      collection: this.getCollectionContextByVideoId(video.id),
      collection_neighbors: this.getNeighborsByVideoId(video.id),
    };
  }

  createBookmark(videoId: number, userId: number, input: any) {
    this.loadData();
    const video = this.videos.find((candidate) => candidate.id === videoId);
    if (!video) return null;

    const now = new Date().toISOString();
    const bookmark = {
      id: this.nextBookmarkId++,
      video_id: videoId,
      user_id: userId,
      timestamp_seconds: input.timestamp_seconds,
      name: input.name,
      description: input.description || null,
      created_at: now,
      updated_at: now,
    };
    video.bookmarks.push(bookmark);
    return { ...bookmark };
  }

  findBookmarkById(id: number) {
    this.loadData();
    for (const video of this.videos) {
      const bookmark = video.bookmarks.find(
        (candidate: any) => candidate.id === id,
      );
      if (bookmark) return { ...bookmark };
    }
    return null;
  }

  getBookmarksForVideo(videoId: number, userId: number) {
    this.loadData();
    const video = this.videos.find((candidate) => candidate.id === videoId);
    if (!video) return null;
    return video.bookmarks
      .filter((bookmark: any) => bookmark.user_id === userId)
      .sort((a: any, b: any) => a.timestamp_seconds - b.timestamp_seconds)
      .map((bookmark: any) => ({ ...bookmark }));
  }

  updateBookmark(id: number, input: any) {
    this.loadData();
    for (const video of this.videos) {
      const bookmark = video.bookmarks.find(
        (candidate: any) => candidate.id === id,
      );
      if (!bookmark) continue;

      if (input.timestamp_seconds !== undefined) {
        bookmark.timestamp_seconds = input.timestamp_seconds;
      }
      if (input.name !== undefined) {
        bookmark.name = input.name;
      }
      if (input.description !== undefined) {
        bookmark.description = input.description;
      }
      bookmark.updated_at = new Date().toISOString();
      return { ...bookmark };
    }
    return null;
  }

  deleteBookmark(id: number) {
    this.loadData();
    for (const video of this.videos) {
      const index = video.bookmarks.findIndex(
        (candidate: any) => candidate.id === id,
      );
      if (index < 0) continue;
      video.bookmarks.splice(index, 1);
      return true;
    }
    return false;
  }

  addRating(videoId: number, input: any) {
    this.loadData();
    const video = this.videos.find((candidate) => candidate.id === videoId);
    if (!video) throw new Error(`Video not found with id: ${videoId}`);
    const rating = {
      id: this.nextRatingId++,
      video_id: videoId,
      rating: input.rating,
      comment: input.comment || null,
      rated_at: new Date().toISOString(),
    };
    video.ratings.push(rating);
    return { ...rating };
  }

  findRatingById(id: number) {
    this.loadData();
    for (const video of this.videos) {
      const rating = video.ratings.find(
        (candidate: any) => candidate.id === id,
      );
      if (rating) return { ...rating };
    }
    return null;
  }

  getRatingsForVideo(videoId: number) {
    this.loadData();
    const video = this.videos.find((candidate) => candidate.id === videoId);
    if (!video) throw new Error(`Video not found with id: ${videoId}`);
    return video.ratings.map((rating: any) => ({ ...rating }));
  }

  updateRating(id: number, input: any) {
    this.loadData();
    for (const video of this.videos) {
      const rating = video.ratings.find(
        (candidate: any) => candidate.id === id,
      );
      if (!rating) continue;
      if (input.rating !== undefined) rating.rating = input.rating;
      if (input.comment !== undefined) rating.comment = input.comment;
      return { ...rating };
    }
    return null;
  }

  deleteRating(id: number) {
    this.loadData();
    for (const video of this.videos) {
      const index = video.ratings.findIndex(
        (candidate: any) => candidate.id === id,
      );
      if (index < 0) continue;
      video.ratings.splice(index, 1);
      return true;
    }
    return false;
  }

  // --- Creator Methods ---
  getCreators(options: any = {}) {
    this.loadData();
    let list = [...this.creators];

    if (options.search) {
      const s = options.search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(s));
    }

    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = list.slice((page - 1) * limit, page * limit).map((c) => ({
      ...c,
      is_favorite: this.isFavoriteCreator(c.id),
      linked_video_count: this.videos.filter((v) =>
        v.creators.some((vc: any) => vc.id === c.id),
      ).length,
      platform_count: c.platforms.length,
      social_link_count: c.social_links.length,
      has_profile_picture: c.profile_picture_path !== null,
      has_main_picture: c.main_picture_path !== null,
      completeness: {
        is_complete: true,
        missing_fields: [],
      },
    }));

    return {
      data: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  getCreatorById(id: number) {
    this.loadData();
    const creator = this.creators.find((c) => c.id === id);
    if (!creator) throw new Error(`Creator not found with id: ${id}`);

    const linkedVideos = this.videos.filter((v) =>
      v.creators.some((vc: any) => vc.id === creator.id),
    );
    return {
      ...creator,
      is_favorite: this.isFavoriteCreator(creator.id),
      linked_video_count: linkedVideos.length,
      platform_count: creator.platforms.length,
      social_link_count: creator.social_links.length,
    };
  }

  getCreatorPlatforms(id: number) {
    return this.getCreatorById(id).platforms;
  }

  getCreatorSocialLinks(id: number) {
    return this.getCreatorById(id).social_links;
  }

  getCreatorGalleryMedia(id: number) {
    return this.getCreatorById(id).gallery_media;
  }

  // --- Studio Methods ---
  getStudios(options: any = {}) {
    this.loadData();
    let list = [...this.studios];

    if (options.search) {
      const s = options.search.toLowerCase();
      list = list.filter((st) => st.name.toLowerCase().includes(s));
    }

    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = list.slice((page - 1) * limit, page * limit).map((s) => ({
      ...s,
      linked_video_count: this.videos.filter((v) =>
        v.studios.some((st: any) => st.id === s.id),
      ).length,
    }));

    return {
      data: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  getStudioById(id: number) {
    this.loadData();
    const studio = this.studios.find((s) => s.id === id);
    if (!studio) throw new Error(`Studio not found with id: ${id}`);

    const linkedVideos = this.videos.filter((v) =>
      v.studios.some((st: any) => st.id === studio.id),
    );
    return {
      ...studio,
      linked_video_count: linkedVideos.length,
    };
  }

  getStudioSocialLinks(id: number) {
    return this.getStudioById(id).social_links;
  }

  // --- Tag Methods ---
  getTags() {
    this.loadData();
    return this.tags;
  }

  // --- Favorites Methods ---
  addFavoriteVideo(videoId: number) {
    this.loadData();
    this.favoritedVideoIds.add(videoId);
    this.favoritedVideoAddedAt.set(videoId, new Date().toISOString());
  }

  removeFavoriteVideo(videoId: number) {
    this.loadData();
    this.favoritedVideoIds.delete(videoId);
    this.favoritedVideoAddedAt.delete(videoId);
  }

  isFavoriteVideo(videoId: number): boolean {
    return this.favoritedVideoIds.has(videoId);
  }

  getFavoriteVideos() {
    this.loadData();
    const list = this.videos
      .filter((v) => this.favoritedVideoIds.has(v.id))
      .map((v) => ({
        ...v,
        is_favorite: true,
        added_at: this.favoritedVideoAddedAt.get(v.id) ?? v.created_at,
        thumbnail_url: v.thumbnail_id
          ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
          : null,
      }));
    return list;
  }

  addFavoriteCreator(creatorId: number) {
    this.loadData();
    this.favoritedCreatorIds.add(creatorId);
  }

  removeFavoriteCreator(creatorId: number) {
    this.loadData();
    this.favoritedCreatorIds.delete(creatorId);
  }

  isFavoriteCreator(creatorId: number): boolean {
    return this.favoritedCreatorIds.has(creatorId);
  }

  // --- Playlist Methods ---
  createPlaylist(userId: number, input: any) {
    this.loadData();
    const id = this.nextPlaylistId++;
    const playlist = {
      id,
      user_id: userId,
      name: input.name,
      description: input.description || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      videoIds: [] as number[],
    };
    this.playlists.set(id, playlist);
    return this.getPlaylistById(id);
  }

  getPlaylistById(id: number) {
    this.loadData();
    const p = this.playlists.get(id);
    if (!p) throw new Error(`Playlist not found with id: ${id}`);

    // First video's thumbnail as playlist thumbnail
    let thumbnail_id: number | null = null;
    if (p.videoIds.length > 0) {
      const firstVideo = this.videos.find((v) => v.id === p.videoIds[0]);
      if (firstVideo && firstVideo.thumbnail_id) {
        thumbnail_id = firstVideo.thumbnail_id;
      }
    }

    return {
      id: p.id,
      user_id: p.user_id,
      name: p.name,
      description: p.description,
      created_at: p.created_at,
      updated_at: p.updated_at,
      video_count: p.videoIds.length,
      thumbnail_url: thumbnail_id
        ? `${API_PREFIX}/thumbnails/${thumbnail_id}/image`
        : null,
    };
  }

  listPlaylists(userId: number) {
    this.loadData();
    const list = Array.from(this.playlists.values())
      .filter((p) => p.user_id === userId)
      .map((p) => this.getPlaylistById(p.id));
    return list;
  }

  updatePlaylist(id: number, userId: number, input: any) {
    this.loadData();
    const p = this.playlists.get(id);
    if (!p) throw new Error(`Playlist not found with id: ${id}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    if (input.name !== undefined) p.name = input.name;
    if (input.description !== undefined) p.description = input.description;
    p.updated_at = new Date().toISOString();

    return this.getPlaylistById(id);
  }

  deletePlaylist(id: number, userId: number) {
    this.loadData();
    const p = this.playlists.get(id);
    if (!p) throw new Error(`Playlist not found with id: ${id}`);
    if (p.user_id !== userId) throw new Error("Forbidden");
    this.playlists.delete(id);
  }

  addVideoToPlaylist(playlistId: number, userId: number, videoId: number) {
    this.loadData();
    const p = this.playlists.get(playlistId);
    if (!p) throw new Error(`Playlist not found with id: ${playlistId}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    // Verify video exists in mock videos
    const v = this.videos.find((vid) => vid.id === videoId);
    if (!v) throw new Error("Video not found");

    if (p.videoIds.includes(videoId)) {
      throw new Error("Video already exists in this playlist");
    }

    p.videoIds.push(videoId);
    p.updated_at = new Date().toISOString();
  }

  removeVideoFromPlaylist(playlistId: number, userId: number, videoId: number) {
    this.loadData();
    const p = this.playlists.get(playlistId);
    if (!p) throw new Error(`Playlist not found with id: ${playlistId}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    p.videoIds = p.videoIds.filter((id: number) => id !== videoId);
    p.updated_at = new Date().toISOString();
  }

  getPlaylistVideos(playlistId: number, userId: number) {
    this.loadData();
    const p = this.playlists.get(playlistId);
    if (!p) throw new Error(`Playlist not found with id: ${playlistId}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    return p.videoIds.map((vid: number, pos: number) => {
      const v = this.getVideoById(vid);
      return {
        ...v,
        position: pos,
        added_to_playlist_at: p.created_at,
        thumbnail_url: v.thumbnail_id
          ? `${API_PREFIX}/thumbnails/${v.thumbnail_id}/image`
          : null,
      };
    });
  }

  reorderPlaylistVideos(
    playlistId: number,
    userId: number,
    positions: { video_id: number; position: number }[],
  ) {
    this.loadData();
    const p = this.playlists.get(playlistId);
    if (!p) throw new Error(`Playlist not found with id: ${playlistId}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    // Sort positions by position index
    const sorted = [...positions].sort((a, b) => a.position - b.position);
    p.videoIds = sorted.map((item) => item.video_id);
    p.updated_at = new Date().toISOString();
  }

  bulkUpdatePlaylistVideos(
    playlistId: number,
    userId: number,
    input: { videoIds: number[]; action: "add" | "remove" },
  ) {
    this.loadData();
    const p = this.playlists.get(playlistId);
    if (!p) throw new Error(`Playlist not found with id: ${playlistId}`);
    if (p.user_id !== userId) throw new Error("Forbidden");

    if (input.action === "add") {
      for (const vid of input.videoIds) {
        if (!p.videoIds.includes(vid)) {
          p.videoIds.push(vid);
        }
      }
    } else {
      p.videoIds = p.videoIds.filter(
        (id: number) => !input.videoIds.includes(id),
      );
    }
    p.updated_at = new Date().toISOString();
  }

  // --- Video Collection Methods ---
  listCollections() {
    this.loadData();
    return Array.from(this.collections.values()).map((c) => {
      const entries = this.listCollectionEntries(c.id);
      return {
        id: c.id,
        title: c.title,
        kind: c.kind,
        description: c.description,
        release_year: c.release_year,
        external_ids_json: c.external_ids_json,
        entry_count: entries.length,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    });
  }

  getCollectionById(id: number) {
    this.loadData();
    const c = this.collections.get(id);
    if (!c) throw new Error(`Collection not found with id: ${id}`);
    const entries = this.listCollectionEntries(c.id);
    return {
      id: c.id,
      title: c.title,
      kind: c.kind,
      description: c.description,
      release_year: c.release_year,
      external_ids_json: c.external_ids_json,
      entry_count: entries.length,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  createCollection(input: any) {
    this.loadData();
    const id = this.nextCollectionId++;
    const collection = {
      id,
      title: input.title,
      kind: input.kind,
      description: input.description || null,
      release_year: input.release_year || null,
      external_ids_json: input.external_ids_json || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.collections.set(id, collection);
    return this.getCollectionById(id);
  }

  updateCollection(id: number, input: any) {
    this.loadData();
    const c = this.collections.get(id);
    if (!c) throw new Error(`Collection not found with id: ${id}`);

    if (input.title !== undefined) c.title = input.title;
    if (input.kind !== undefined) c.kind = input.kind;
    if (input.description !== undefined) c.description = input.description;
    if (input.release_year !== undefined) c.release_year = input.release_year;
    if (input.external_ids_json !== undefined)
      c.external_ids_json = input.external_ids_json;
    c.updated_at = new Date().toISOString();

    return this.getCollectionById(id);
  }

  deleteCollection(id: number) {
    this.loadData();
    if (!this.collections.has(id)) throw new Error("Collection not found");
    this.collections.delete(id);
    // clean up entries
    for (const [entryId, entry] of this.collectionEntries.entries()) {
      if (entry.collectionId === id) {
        this.collectionEntries.delete(entryId);
      }
    }
  }

  listCollectionEntries(collectionId: number) {
    this.loadData();
    const entries = Array.from(this.collectionEntries.values())
      .filter((e) => e.collectionId === collectionId)
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));

    return entries.map((e) => {
      const v = this.videos.find((vid) => vid.id === e.videoId)!;
      return {
        id: e.id,
        collection_id: e.collectionId,
        video_id: e.videoId,
        entry_kind: e.entryKind,
        sequence_number: e.sequenceNumber,
        season_number: e.seasonNumber,
        episode_number: e.episodeNumber,
        episode_part: e.episodePart,
        absolute_number: e.absoluteNumber,
        display_title_override: e.displayTitleOverride,
        created_at: e.created_at,
        updated_at: e.updated_at,
        video: {
          id: v.id,
          file_name: v.file_name,
          title: v.title,
          thumbnail_id: v.thumbnail_id,
          thumbnail_url: v.thumbnail_url,
          is_available: v.is_available,
        },
      };
    });
  }

  addCollectionEntry(collectionId: number, input: any) {
    this.loadData();
    const c = this.collections.get(collectionId);
    if (!c) throw new Error("Collection not found");

    // Check if video already in any collection
    const exists = Array.from(this.collectionEntries.values()).some(
      (e) => e.videoId === input.video_id,
    );
    if (exists) throw new Error("Video already belongs to a collection");

    const id = this.nextCollectionEntryId++;
    const entry = {
      id,
      collectionId,
      videoId: input.video_id,
      entryKind: input.entry_kind,
      sequenceNumber: input.sequence_number ?? null,
      seasonNumber: input.season_number ?? null,
      episodeNumber: input.episode_number ?? null,
      episodePart: input.episode_part ?? null,
      absoluteNumber: input.absolute_number ?? null,
      displayTitleOverride: input.display_title_override ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.collectionEntries.set(id, entry);
    c.updated_at = new Date().toISOString();

    const list = this.listCollectionEntries(collectionId);
    return list.find((e) => e.id === id)!;
  }

  removeCollectionEntry(collectionId: number, videoId: number) {
    this.loadData();
    const c = this.collections.get(collectionId);
    if (!c) throw new Error("Collection not found");

    const entry = Array.from(this.collectionEntries.values()).find(
      (e) => e.collectionId === collectionId && e.videoId === videoId,
    );
    if (!entry) throw new Error("Entry not found");

    this.collectionEntries.delete(entry.id);
    c.updated_at = new Date().toISOString();
  }

  reorderCollectionEntries(collectionId: number, input: any) {
    this.loadData();
    const c = this.collections.get(collectionId);
    if (!c) throw new Error("Collection not found");

    for (const item of input.entries) {
      const entry = Array.from(this.collectionEntries.values()).find(
        (e) => e.collectionId === collectionId && e.videoId === item.video_id,
      );
      if (entry) {
        entry.sequenceNumber = item.sequence_number ?? null;
        entry.seasonNumber = item.season_number ?? null;
        entry.episodeNumber = item.episode_number ?? null;
        entry.episodePart = item.episode_part ?? null;
        entry.absoluteNumber = item.absolute_number ?? null;
        entry.updated_at = new Date().toISOString();
      }
    }
    c.updated_at = new Date().toISOString();
    return this.listCollectionEntries(collectionId);
  }

  getCollectionContextByVideoId(videoId: number) {
    this.loadData();
    const entry = Array.from(this.collectionEntries.values()).find(
      (e) => e.videoId === videoId,
    );
    if (!entry) return null;

    const c = this.collections.get(entry.collectionId);
    if (!c) return null;

    return {
      entry_id: entry.id,
      collection_id: c.id,
      title: c.title,
      kind: c.kind,
      description: c.description,
      release_year: c.release_year,
      entry: {
        id: entry.id,
        collection_id: c.id,
        video_id: videoId,
        entry_kind: entry.entryKind,
        sequence_number: entry.sequenceNumber,
        season_number: entry.seasonNumber,
        episode_number: entry.episodeNumber,
        episode_part: entry.episodePart,
        absolute_number: entry.absoluteNumber,
        display_title_override: entry.displayTitleOverride,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      },
    };
  }

  getCollectionContextsByVideoIds(videoIds: number[]) {
    this.loadData();
    const map = new Map<number, any>();
    for (const vid of videoIds) {
      const ctx = this.getCollectionContextByVideoId(vid);
      if (ctx) {
        map.set(vid, ctx);
      }
    }
    return map;
  }

  getNeighborsByVideoId(videoId: number) {
    this.loadData();
    const ctx = this.getCollectionContextByVideoId(videoId);
    if (!ctx) return null;

    const entries = this.listCollectionEntries(ctx.collection_id);
    const idx = entries.findIndex((e) => e.video_id === videoId);
    if (idx === -1) return null;

    const mapNeighbor = (e: any) => {
      if (!e) return null;
      return {
        video_id: e.video_id,
        entry_id: e.id,
        title: e.video.title,
        file_name: e.video.file_name,
        display_title_override: e.display_title_override,
        sequence_number: e.sequence_number,
        season_number: e.season_number,
        episode_number: e.episode_number,
        episode_part: e.episode_part,
        absolute_number: e.absolute_number,
        thumbnail_id: e.video.thumbnail_id,
        thumbnail_url: e.video.thumbnail_url,
      };
    };

    return {
      previous: mapNeighbor(entries[idx - 1]),
      next: mapNeighbor(entries[idx + 1]),
    };
  }
}

export const demoMockService = new DemoMockService();
