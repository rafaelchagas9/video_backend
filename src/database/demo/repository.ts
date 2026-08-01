import { API_PREFIX } from "@/config/constants";
import { ConflictError, ForbiddenError, NotFoundError } from "@/utils/errors";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "./client";

const DEMO_USER_ID = 1;
type DemoPage = {
  data: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function now(): string {
  return new Date().toISOString();
}

export class DemoRepository {
  private ensureReady(): void {
    initializeDemoDatabase();
    const count = this.scalar("SELECT count(*) FROM demo_videos");
    if (count === 0) {
      throw new Error(
        "Demo SQLite database has no seed. Run `bun run demo:download` to build a fresh demo, or `bun run demo:migrate-json` for a legacy JSON migration."
      );
    }
  }

  private rows(sql: string, ...params: any[]): any[] {
    return getDemoSqlite()
      .query(sql)
      .all(...params) as any[];
  }

  private row(sql: string, ...params: any[]): any | null {
    return (
      (getDemoSqlite()
        .query(sql)
        .get(...params) as any) ?? null
    );
  }

  private scalar(sql: string, ...params: any[]): number {
    const result = this.row(sql, ...params);
    if (!result) return 0;
    return Number(Object.values(result)[0] ?? 0);
  }

  getTags(): any[] {
    this.ensureReady();
    return this.rows("SELECT * FROM demo_tags ORDER BY id").map((tag) => ({
      id: Number(tag.id),
      name: tag.name,
      parent_id: tag.parent_id === null ? null : Number(tag.parent_id),
      description: tag.description,
      color: tag.color,
      created_at: tag.created_at,
      updated_at: tag.updated_at,
    }));
  }

  private studioFromRow(row: any): any {
    const socialLinks = this.rows(
      "SELECT * FROM demo_studio_social_links WHERE studio_id = ? ORDER BY id",
      row.id
    ).map((link) => ({
      id: Number(link.id),
      studio_id: Number(link.studio_id),
      platform_name: link.platform_name,
      url: link.url,
      created_at: link.created_at,
    }));
    const linkedVideoCount = this.scalar(
      "SELECT count(*) FROM demo_video_studios WHERE studio_id = ?",
      row.id
    );
    return {
      id: Number(row.id),
      name: row.name,
      description: row.description,
      profile_picture_path: row.profile_picture_path,
      profile_picture_url: row.profile_picture_path
        ? `${API_PREFIX}/studios/${row.id}/picture`
        : undefined,
      social_links: socialLinks,
      linked_video_count: linkedVideoCount,
      social_link_count: socialLinks.length,
      linked_creator_count: 0,
      has_profile_picture: row.profile_picture_path !== null,
      completeness: {
        is_complete:
          row.profile_picture_path !== null &&
          socialLinks.length > 0 &&
          linkedVideoCount > 0,
        missing_fields: [
          ...(row.profile_picture_path === null ? ["picture"] : []),
          ...(socialLinks.length === 0 ? ["social"] : []),
          ...(linkedVideoCount === 0 ? ["linked"] : []),
        ],
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getStudios(options: any = {}): DemoPage {
    this.ensureReady();
    let list = this.rows("SELECT * FROM demo_studios ORDER BY name").map(
      (row) => this.studioFromRow(row)
    );
    if (options.search) {
      const search = String(options.search).toLowerCase();
      list = list.filter((studio) =>
        studio.name.toLowerCase().includes(search)
      );
    }
    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    return {
      data: list.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  getStudioById(id: number): any {
    this.ensureReady();
    const row = this.row("SELECT * FROM demo_studios WHERE id = ?", id);
    if (!row) throw new NotFoundError(`Studio not found with id: ${id}`);
    return this.studioFromRow(row);
  }

  getStudioSocialLinks(id: number): any[] {
    return this.getStudioById(id).social_links;
  }

  private creatorFromRow(row: any): any {
    const id = Number(row.id);
    const aliases = this.rows(
      "SELECT * FROM demo_creator_aliases WHERE creator_id = ? ORDER BY id",
      id
    ).map((item) => ({
      id: Number(item.id),
      creator_id: id,
      name: item.name,
      note: item.note,
      created_at: item.created_at,
    }));
    const platforms = this.rows(
      "SELECT * FROM demo_creator_platforms WHERE creator_id = ? ORDER BY id",
      id
    ).map((item) => ({
      id: Number(item.id),
      creator_id: id,
      platform_id: Number(item.platform_id),
      platform_name: item.platform_name,
      username: item.username,
      profile_url: item.profile_url,
      is_primary: Boolean(item.is_primary),
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));
    const socialLinks = this.rows(
      "SELECT * FROM demo_creator_social_links WHERE creator_id = ? ORDER BY id",
      id
    ).map((item) => ({
      id: Number(item.id),
      creator_id: id,
      platform_name: item.platform_name,
      url: item.url,
      created_at: item.created_at,
    }));
    const gallery = this.rows(
      "SELECT * FROM demo_creator_gallery WHERE creator_id = ? ORDER BY id",
      id
    ).map((item) => ({
      id: Number(item.id),
      creator_id: id,
      label: item.label,
      description: item.description,
      file_path: item.file_path,
      is_profile_picture: Boolean(item.is_profile_picture),
      is_main_picture: Boolean(item.is_main_picture),
      url: `${API_PREFIX}/creators/${id}/gallery/${item.id}/image`,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));
    const faceEmbeddings = this.rows(
      "SELECT * FROM demo_creator_face_embeddings WHERE creator_id = ? ORDER BY id",
      id
    ).map((item) => ({
      ...parseJson<Record<string, unknown>>(item.payload_json, {}),
      id: Number(item.id),
      creator_id: id,
      thumbnailPath: item.thumbnail_path,
      is_primary: Boolean(item.is_primary),
    }));
    const linkedVideoCount = this.scalar(
      "SELECT count(*) FROM demo_video_creators WHERE creator_id = ?",
      id
    );
    const extra = parseJson<Record<string, unknown>>(row.extra_json, {});
    return {
      ...extra,
      id,
      name: row.name,
      description: row.description,
      profile_picture_path: row.profile_picture_path,
      main_picture_path: row.main_picture_path,
      face_thumbnail_path: row.face_thumbnail_path,
      profile_picture_url: row.profile_picture_path
        ? `${API_PREFIX}/creators/${id}/picture`
        : undefined,
      main_picture_url: row.main_picture_path
        ? `${API_PREFIX}/creators/${id}/picture?variant=main`
        : undefined,
      face_thumbnail_url: row.face_thumbnail_path
        ? `${API_PREFIX}/creators/${id}/picture?type=face`
        : undefined,
      aliases,
      platforms,
      social_links: socialLinks,
      gallery_media: gallery,
      face_embeddings: faceEmbeddings,
      is_favorite: this.isFavoriteCreator(id),
      linked_video_count: linkedVideoCount,
      platform_count: platforms.length,
      social_link_count: socialLinks.length,
      has_profile_picture: row.profile_picture_path !== null,
      has_main_picture: row.main_picture_path !== null,
      completeness: { is_complete: true, missing_fields: [] },
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getCreators(options: any = {}): DemoPage {
    this.ensureReady();
    let list = this.rows("SELECT * FROM demo_creators ORDER BY name").map(
      (row) => this.creatorFromRow(row)
    );
    if (options.search) {
      const search = String(options.search).toLowerCase();
      list = list.filter((creator) =>
        creator.name.toLowerCase().includes(search)
      );
    }
    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    return {
      data: list.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  getCreatorById(id: number): any {
    this.ensureReady();
    const row = this.row("SELECT * FROM demo_creators WHERE id = ?", id);
    if (!row) throw new NotFoundError(`Creator not found with id: ${id}`);
    return this.creatorFromRow(row);
  }

  getCreatorPlatforms(id: number): any[] {
    return this.getCreatorById(id).platforms;
  }
  getCreatorSocialLinks(id: number): any[] {
    return this.getCreatorById(id).social_links;
  }
  getCreatorGalleryMedia(id: number): any[] {
    return this.getCreatorById(id).gallery_media;
  }
  getCreatorAliases(id: number): any[] {
    return this.getCreatorById(id).aliases;
  }
  getCreatorFaceEmbeddings(id: number): any[] {
    return this.getCreatorById(id).face_embeddings;
  }

  getCreatorFaceEmbeddingPath(
    creatorId: number,
    embeddingId: number | string
  ): string | null {
    const item = this.row(
      "SELECT thumbnail_path FROM demo_creator_face_embeddings WHERE creator_id = ? AND id = ?",
      creatorId,
      Number(embeddingId)
    );
    return item?.thumbnail_path ?? null;
  }

  private videoFromRow(row: any): any {
    const id = Number(row.id);
    const thumbnail = this.row(
      "SELECT * FROM demo_thumbnails WHERE video_id = ?",
      id
    );
    const storyboard = this.row(
      "SELECT * FROM demo_storyboards WHERE video_id = ?",
      id
    );
    const creators = this.rows(
      "SELECT c.* FROM demo_creators c JOIN demo_video_creators vc ON vc.creator_id = c.id WHERE vc.video_id = ? ORDER BY c.name",
      id
    ).map((creator) => this.creatorFromRow(creator));
    const studios = this.rows(
      "SELECT s.* FROM demo_studios s JOIN demo_video_studios vs ON vs.studio_id = s.id WHERE vs.video_id = ? ORDER BY s.name",
      id
    ).map((studio) => this.studioFromRow(studio));
    const tags = this.rows(
      "SELECT t.* FROM demo_tags t JOIN demo_video_tags vt ON vt.tag_id = t.id WHERE vt.video_id = ? ORDER BY t.name",
      id
    ).map((tag) => ({
      id: Number(tag.id),
      name: tag.name,
      parent_id: tag.parent_id === null ? null : Number(tag.parent_id),
      description: tag.description,
      color: tag.color,
      created_at: tag.created_at,
      updated_at: tag.updated_at,
    }));
    const ratings = this.getRatingsForVideoInternal(id);
    const bookmarks = this.getBookmarksForVideoInternal(id, DEMO_USER_ID);
    const statsRow = this.row(
      "SELECT * FROM demo_video_stats WHERE user_id = ? AND video_id = ?",
      DEMO_USER_ID,
      id
    );
    const stats = {
      playCount: Number(statsRow?.play_count ?? 0),
      totalWatchSeconds: Number(statsRow?.total_watch_seconds ?? 0),
      lastPositionSeconds: Number(statsRow?.last_position_seconds ?? 0),
    };
    return {
      id,
      file_path: row.file_path,
      file_name: row.file_name,
      directory_id: Number(row.directory_id),
      file_size_bytes: Number(row.file_size_bytes),
      file_hash: row.file_hash,
      duration_seconds:
        row.duration_seconds === null ? null : Number(row.duration_seconds),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      codec: row.codec,
      bitrate: row.bitrate === null ? null : Number(row.bitrate),
      fps: row.fps === null ? null : Number(row.fps),
      audio_codec: row.audio_codec,
      title: row.title,
      description: row.description,
      themes: row.themes,
      is_available: Boolean(row.is_available),
      is_favorite: this.isFavoriteVideo(id),
      last_verified_at: row.last_verified_at,
      indexed_at: row.indexed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      thumbnail_id: thumbnail ? id : null,
      thumbnail_url: thumbnail ? `${API_PREFIX}/thumbnails/${id}/image` : null,
      thumbnail: thumbnail
        ? {
            id,
            video_id: id,
            file_path: thumbnail.file_path,
            file_size_bytes: Number(thumbnail.file_size_bytes),
            timestamp_seconds: Number(thumbnail.timestamp_seconds),
            width: Number(thumbnail.width),
            height: Number(thumbnail.height),
            generated_at: thumbnail.generated_at,
          }
        : null,
      storyboard: storyboard
        ? {
            id,
            video_id: id,
            sprite_path: storyboard.sprite_path,
            vtt_path: storyboard.vtt_path,
            tile_width: Number(storyboard.tile_width),
            tile_height: Number(storyboard.tile_height),
            tile_count: Number(storyboard.tile_count),
            interval_seconds: Number(storyboard.interval_seconds),
            sprite_size_bytes: Number(storyboard.sprite_size_bytes),
            generated_at: storyboard.generated_at,
          }
        : null,
      creators,
      studios,
      tags,
      ratings,
      bookmarks,
      stats,
      collection: this.getCollectionContextByVideoId(id),
    };
  }

  getVideos(options: any = {}): DemoPage {
    this.ensureReady();
    let list = this.rows("SELECT * FROM demo_videos ORDER BY id").map((row) =>
      this.videoFromRow(row)
    );
    if (
      options.ids &&
      (Array.isArray(options.ids) ? options.ids.length : true)
    ) {
      const ids = (
        Array.isArray(options.ids) ? options.ids : [options.ids]
      ).map(Number);
      list = list.filter((video) => ids.includes(video.id));
    }
    if (options.search) {
      const search = String(options.search).toLowerCase();
      list = list.filter((video) =>
        [video.title, video.description, video.themes]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search))
      );
    }
    const filterRelation = (
      key: "tags" | "creators" | "studios",
      values: any
    ) => {
      if (!values || values.length === 0) return;
      const ids = (Array.isArray(values) ? values : [values]).map(Number);
      list = list.filter((video) =>
        video[key].some((item: any) => ids.includes(item.id))
      );
    };
    filterRelation("tags", options.tagIds);
    filterRelation("creators", options.creatorIds);
    filterRelation("studios", options.studioIds);
    if (options.createdFrom) {
      const timestamp = new Date(options.createdFrom).getTime();
      list = list.filter(
        (video) => new Date(video.created_at).getTime() >= timestamp
      );
    }
    if (options.createdBefore) {
      const timestamp = new Date(options.createdBefore).getTime();
      list = list.filter(
        (video) => new Date(video.created_at).getTime() < timestamp
      );
    }
    const page = Number(options.page || 1);
    const limit = Number(options.limit || 20);
    const total = list.length;
    return {
      data: list.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  getVideoById(id: number): any {
    this.ensureReady();
    const row = this.row("SELECT * FROM demo_videos WHERE id = ?", id);
    if (!row) throw new NotFoundError(`Video not found with id: ${id}`);
    return {
      ...this.videoFromRow(row),
      collection_neighbors: this.getNeighborsByVideoId(id),
    };
  }

  addFavoriteVideo(videoId: number): void {
    this.ensureReady();
    getDemoSqlite().run(
      "INSERT OR IGNORE INTO demo_favorites (user_id,video_id,added_at) VALUES (?,?,?)",
      [DEMO_USER_ID, videoId, now()]
    );
  }
  removeFavoriteVideo(videoId: number): void {
    getDemoSqlite().run(
      "DELETE FROM demo_favorites WHERE user_id = ? AND video_id = ?",
      [DEMO_USER_ID, videoId]
    );
  }
  isFavoriteVideo(videoId: number): boolean {
    return Boolean(
      this.row(
        "SELECT 1 FROM demo_favorites WHERE user_id = ? AND video_id = ?",
        DEMO_USER_ID,
        videoId
      )
    );
  }
  getFavoriteVideos(): any[] {
    this.ensureReady();
    return this.rows(
      "SELECT v.*, f.added_at FROM demo_videos v JOIN demo_favorites f ON f.video_id = v.id WHERE f.user_id = ? ORDER BY f.added_at DESC",
      DEMO_USER_ID
    ).map((row) => ({
      ...this.videoFromRow(row),
      added_at: row.added_at,
      is_favorite: true,
    }));
  }
  addFavoriteCreator(creatorId: number): void {
    this.ensureReady();
    getDemoSqlite().run(
      "INSERT OR IGNORE INTO demo_creator_favorites (user_id,creator_id,added_at) VALUES (?,?,?)",
      [DEMO_USER_ID, creatorId, now()]
    );
  }
  removeFavoriteCreator(creatorId: number): void {
    getDemoSqlite().run(
      "DELETE FROM demo_creator_favorites WHERE user_id = ? AND creator_id = ?",
      [DEMO_USER_ID, creatorId]
    );
  }
  isFavoriteCreator(creatorId: number): boolean {
    return Boolean(
      this.row(
        "SELECT 1 FROM demo_creator_favorites WHERE user_id = ? AND creator_id = ?",
        DEMO_USER_ID,
        creatorId
      )
    );
  }

  createBookmark(videoId: number, userId: number, input: any): any {
    this.getVideoById(videoId);
    const timestamp = now();
    const result = getDemoSqlite().run(
      "INSERT INTO demo_bookmarks (video_id,user_id,timestamp_seconds,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [
        videoId,
        userId,
        input.timestamp_seconds,
        input.name,
        input.description ?? null,
        timestamp,
        timestamp,
      ]
    );
    return this.findBookmarkById(Number(result.lastInsertRowid));
  }
  findBookmarkById(id: number): any | null {
    const item = this.row("SELECT * FROM demo_bookmarks WHERE id = ?", id);
    return item ? this.mapBookmark(item) : null;
  }
  private mapBookmark(item: any): any {
    return {
      id: Number(item.id),
      video_id: Number(item.video_id),
      user_id: Number(item.user_id),
      timestamp_seconds: Number(item.timestamp_seconds),
      name: item.name,
      description: item.description,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
  private getBookmarksForVideoInternal(videoId: number, userId: number): any[] {
    return this.rows(
      "SELECT * FROM demo_bookmarks WHERE video_id = ? AND user_id = ? ORDER BY timestamp_seconds",
      videoId,
      userId
    ).map((item) => this.mapBookmark(item));
  }
  getBookmarksForVideo(videoId: number, userId: number): any[] | null {
    if (!this.row("SELECT 1 FROM demo_videos WHERE id = ?", videoId))
      return null;
    return this.getBookmarksForVideoInternal(videoId, userId);
  }
  updateBookmark(id: number, input: any): any | null {
    const current = this.findBookmarkById(id);
    if (!current) return null;
    getDemoSqlite().run(
      "UPDATE demo_bookmarks SET timestamp_seconds=?,name=?,description=?,updated_at=? WHERE id=?",
      [
        input.timestamp_seconds ?? current.timestamp_seconds,
        input.name ?? current.name,
        input.description ?? current.description,
        now(),
        id,
      ]
    );
    return this.findBookmarkById(id);
  }
  deleteBookmark(id: number): boolean {
    return (
      getDemoSqlite().run("DELETE FROM demo_bookmarks WHERE id = ?", [id])
        .changes > 0
    );
  }

  addRating(videoId: number, input: any): any {
    this.getVideoById(videoId);
    const result = getDemoSqlite().run(
      "INSERT INTO demo_ratings (video_id,rating,comment,rated_at) VALUES (?,?,?,?)",
      [videoId, input.rating, input.comment ?? null, now()]
    );
    return this.findRatingById(Number(result.lastInsertRowid));
  }
  findRatingById(id: number): any | null {
    const item = this.row("SELECT * FROM demo_ratings WHERE id = ?", id);
    return item ? this.mapRating(item) : null;
  }
  private mapRating(item: any): any {
    return {
      id: Number(item.id),
      video_id: Number(item.video_id),
      rating: Number(item.rating),
      comment: item.comment,
      rated_at: item.rated_at,
    };
  }
  private getRatingsForVideoInternal(videoId: number): any[] {
    return this.rows(
      "SELECT * FROM demo_ratings WHERE video_id = ? ORDER BY id",
      videoId
    ).map((item) => this.mapRating(item));
  }
  getRatingsForVideo(videoId: number): any[] {
    this.getVideoByIdShallow(videoId);
    return this.getRatingsForVideoInternal(videoId);
  }
  private getVideoByIdShallow(id: number): void {
    if (!this.row("SELECT 1 FROM demo_videos WHERE id = ?", id))
      throw new NotFoundError(`Video not found with id: ${id}`);
  }
  updateRating(id: number, input: any): any | null {
    const current = this.findRatingById(id);
    if (!current) return null;
    getDemoSqlite().run(
      "UPDATE demo_ratings SET rating=?,comment=? WHERE id=?",
      [input.rating ?? current.rating, input.comment ?? current.comment, id]
    );
    return this.findRatingById(id);
  }
  deleteRating(id: number): boolean {
    return (
      getDemoSqlite().run("DELETE FROM demo_ratings WHERE id = ?", [id])
        .changes > 0
    );
  }

  createPlaylist(userId: number, input: any): any {
    const timestamp = now();
    const result = getDemoSqlite().run(
      "INSERT INTO demo_playlists (user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)",
      [userId, input.name, input.description ?? null, timestamp, timestamp]
    );
    return this.getPlaylistById(Number(result.lastInsertRowid));
  }
  getPlaylistById(id: number): any {
    const playlist = this.row("SELECT * FROM demo_playlists WHERE id = ?", id);
    if (!playlist) throw new NotFoundError(`Playlist not found with id: ${id}`);
    const first = this.row(
      "SELECT pv.video_id FROM demo_playlist_videos pv WHERE pv.playlist_id = ? ORDER BY pv.position LIMIT 1",
      id
    );
    return {
      id: Number(playlist.id),
      user_id: Number(playlist.user_id),
      name: playlist.name,
      description: playlist.description,
      created_at: playlist.created_at,
      updated_at: playlist.updated_at,
      video_count: this.scalar(
        "SELECT count(*) FROM demo_playlist_videos WHERE playlist_id = ?",
        id
      ),
      thumbnail_url: first
        ? `${API_PREFIX}/thumbnails/${first.video_id}/image`
        : null,
    };
  }
  listPlaylists(userId: number): any[] {
    return this.rows(
      "SELECT id FROM demo_playlists WHERE user_id = ? ORDER BY id",
      userId
    ).map((item) => this.getPlaylistById(Number(item.id)));
  }
  updatePlaylist(id: number, userId: number, input: any): any {
    const current = this.getPlaylistById(id);
    if (current.user_id !== userId) throw new ForbiddenError();
    getDemoSqlite().run(
      "UPDATE demo_playlists SET name=?,description=?,updated_at=? WHERE id=?",
      [
        input.name ?? current.name,
        input.description ?? current.description,
        now(),
        id,
      ]
    );
    return this.getPlaylistById(id);
  }
  deletePlaylist(id: number, userId: number): void {
    const current = this.getPlaylistById(id);
    if (current.user_id !== userId) throw new ForbiddenError();
    getDemoSqlite().run("DELETE FROM demo_playlists WHERE id = ?", [id]);
  }
  addVideoToPlaylist(
    playlistId: number,
    userId: number,
    videoId: number
  ): void {
    const playlist = this.getPlaylistById(playlistId);
    if (playlist.user_id !== userId) throw new ForbiddenError();
    this.getVideoByIdShallow(videoId);
    if (
      this.row(
        "SELECT 1 FROM demo_playlist_videos WHERE playlist_id=? AND video_id=?",
        playlistId,
        videoId
      )
    )
      throw new ConflictError("Video already exists in this playlist");
    getDemoSqlite().run(
      "INSERT INTO demo_playlist_videos (playlist_id,video_id,position,added_at) VALUES (?,?,?,?)",
      [playlistId, videoId, playlist.video_count, now()]
    );
  }
  removeVideoFromPlaylist(
    playlistId: number,
    userId: number,
    videoId: number
  ): void {
    const playlist = this.getPlaylistById(playlistId);
    if (playlist.user_id !== userId) throw new ForbiddenError();
    getDemoSqlite().run(
      "DELETE FROM demo_playlist_videos WHERE playlist_id=? AND video_id=?",
      [playlistId, videoId]
    );
  }
  getPlaylistVideos(playlistId: number, userId: number): any[] {
    const playlist = this.getPlaylistById(playlistId);
    if (playlist.user_id !== userId) throw new ForbiddenError();
    return this.rows(
      "SELECT * FROM demo_playlist_videos WHERE playlist_id=? ORDER BY position",
      playlistId
    ).map((item) => ({
      ...this.getVideoById(Number(item.video_id)),
      position: Number(item.position),
      added_to_playlist_at: item.added_at,
    }));
  }
  reorderPlaylistVideos(
    playlistId: number,
    userId: number,
    positions: any[]
  ): void {
    const playlist = this.getPlaylistById(playlistId);
    if (playlist.user_id !== userId) throw new ForbiddenError();
    withDemoTransaction(() => {
      positions.forEach((item) =>
        getDemoSqlite().run(
          "UPDATE demo_playlist_videos SET position=? WHERE playlist_id=? AND video_id=?",
          [item.position, playlistId, item.video_id]
        )
      );
      getDemoSqlite().run("UPDATE demo_playlists SET updated_at=? WHERE id=?", [
        now(),
        playlistId,
      ]);
    });
  }
  bulkUpdatePlaylistVideos(
    playlistId: number,
    userId: number,
    input: any
  ): void {
    for (const videoId of input.videoIds) {
      const exists = this.row(
        "SELECT 1 FROM demo_playlist_videos WHERE playlist_id=? AND video_id=?",
        playlistId,
        videoId
      );
      if (input.action === "add" && !exists)
        this.addVideoToPlaylist(playlistId, userId, videoId);
      if (input.action === "remove" && exists)
        this.removeVideoFromPlaylist(playlistId, userId, videoId);
    }
  }

  listCollections(): any[] {
    this.ensureReady();
    return this.rows("SELECT id FROM demo_collections ORDER BY id").map(
      (item) => this.getCollectionById(Number(item.id))
    );
  }
  getCollectionById(id: number): any {
    const item = this.row("SELECT * FROM demo_collections WHERE id=?", id);
    if (!item) {
      throw new NotFoundError(`Video collection not found with id: ${id}`);
    }
    return {
      id: Number(item.id),
      title: item.title,
      kind: item.kind,
      description: item.description,
      release_year: item.release_year,
      external_ids_json: item.external_ids_json,
      entry_count: this.scalar(
        "SELECT count(*) FROM demo_collection_entries WHERE collection_id=?",
        id
      ),
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
  createCollection(input: any): any {
    const timestamp = now();
    const result = getDemoSqlite().run(
      "INSERT INTO demo_collections (title,kind,description,release_year,external_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [
        input.title,
        input.kind,
        input.description ?? null,
        input.release_year ?? null,
        input.external_ids_json ?? null,
        timestamp,
        timestamp,
      ]
    );
    return this.getCollectionById(Number(result.lastInsertRowid));
  }
  updateCollection(id: number, input: any): any {
    const current = this.getCollectionById(id);
    getDemoSqlite().run(
      "UPDATE demo_collections SET title=?,kind=?,description=?,release_year=?,external_ids_json=?,updated_at=? WHERE id=?",
      [
        input.title ?? current.title,
        input.kind ?? current.kind,
        input.description ?? current.description,
        input.release_year ?? current.release_year,
        input.external_ids_json ?? current.external_ids_json,
        now(),
        id,
      ]
    );
    return this.getCollectionById(id);
  }
  deleteCollection(id: number): void {
    if (
      !getDemoSqlite().run("DELETE FROM demo_collections WHERE id=?", [id])
        .changes
    )
      throw new NotFoundError(`Video collection not found with id: ${id}`);
  }
  listCollectionEntries(collectionId: number): any[] {
    this.getCollectionById(collectionId);
    return this.rows(
      "SELECT * FROM demo_collection_entries WHERE collection_id=? ORDER BY sequence_number,id",
      collectionId
    ).map((item) => {
      const video = this.getVideoByIdShallowRecord(Number(item.video_id));
      return {
        id: Number(item.id),
        collection_id: Number(item.collection_id),
        video_id: Number(item.video_id),
        entry_kind: item.entry_kind,
        sequence_number: item.sequence_number,
        season_number: item.season_number,
        episode_number: item.episode_number,
        episode_part: item.episode_part,
        absolute_number: item.absolute_number,
        display_title_override: item.display_title_override,
        created_at: item.created_at,
        updated_at: item.updated_at,
        video,
      };
    });
  }
  private getVideoByIdShallowRecord(id: number): any {
    const item = this.row("SELECT * FROM demo_videos WHERE id=?", id);
    if (!item) throw new NotFoundError(`Video not found with id: ${id}`);
    return {
      id,
      file_name: item.file_name,
      title: item.title,
      thumbnail_id: this.row(
        "SELECT 1 FROM demo_thumbnails WHERE video_id=?",
        id
      )
        ? id
        : null,
      thumbnail_url: this.row(
        "SELECT 1 FROM demo_thumbnails WHERE video_id=?",
        id
      )
        ? `${API_PREFIX}/thumbnails/${id}/image`
        : null,
      is_available: Boolean(item.is_available),
    };
  }
  addCollectionEntry(collectionId: number, input: any): any {
    this.getCollectionById(collectionId);
    this.getVideoByIdShallowRecord(Number(input.video_id));
    if (
      this.row(
        "SELECT 1 FROM demo_collection_entries WHERE video_id=?",
        input.video_id
      )
    ) {
      throw new ConflictError("Video already belongs to a collection");
    }
    const timestamp = now();
    const result = getDemoSqlite().run(
      "INSERT INTO demo_collection_entries (collection_id,video_id,entry_kind,sequence_number,season_number,episode_number,episode_part,absolute_number,display_title_override,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        collectionId,
        input.video_id,
        input.entry_kind,
        input.sequence_number ?? null,
        input.season_number ?? null,
        input.episode_number ?? null,
        input.episode_part ?? null,
        input.absolute_number ?? null,
        input.display_title_override ?? null,
        timestamp,
        timestamp,
      ]
    );
    return this.listCollectionEntries(collectionId).find(
      (item) => item.id === Number(result.lastInsertRowid)
    );
  }
  removeCollectionEntry(collectionId: number, videoId: number): void {
    this.getCollectionById(collectionId);
    if (
      !getDemoSqlite().run(
        "DELETE FROM demo_collection_entries WHERE collection_id=? AND video_id=?",
        [collectionId, videoId]
      ).changes
    )
      throw new NotFoundError(
        `Video collection entry not found for video id: ${videoId}`
      );
  }
  reorderCollectionEntries(collectionId: number, input: any): any[] {
    this.getCollectionById(collectionId);
    const existingVideoIds = new Set(
      this.rows(
        "SELECT video_id FROM demo_collection_entries WHERE collection_id=?",
        collectionId
      ).map((item) => Number(item.video_id))
    );
    for (const item of input.entries) {
      if (!existingVideoIds.has(Number(item.video_id))) {
        throw new NotFoundError(
          `Collection entry not found for video id: ${item.video_id}`
        );
      }
    }
    withDemoTransaction(() => {
      for (const item of input.entries) {
        getDemoSqlite().run(
          "UPDATE demo_collection_entries SET sequence_number=?,season_number=?,episode_number=?,episode_part=?,absolute_number=?,updated_at=? WHERE collection_id=? AND video_id=?",
          [
            item.sequence_number ?? null,
            item.season_number ?? null,
            item.episode_number ?? null,
            item.episode_part ?? null,
            item.absolute_number ?? null,
            now(),
            collectionId,
            item.video_id,
          ]
        );
      }
    });
    return this.listCollectionEntries(collectionId);
  }
  getCollectionContextByVideoId(videoId: number): any | null {
    const item = this.row(
      "SELECT * FROM demo_collection_entries WHERE video_id=?",
      videoId
    );
    if (!item) return null;
    const collection = this.getCollectionById(Number(item.collection_id));
    return {
      entry_id: Number(item.id),
      collection_id: collection.id,
      title: collection.title,
      kind: collection.kind,
      description: collection.description,
      release_year: collection.release_year,
      entry: {
        id: Number(item.id),
        collection_id: collection.id,
        video_id: videoId,
        entry_kind: item.entry_kind,
        sequence_number: item.sequence_number,
        season_number: item.season_number,
        episode_number: item.episode_number,
        episode_part: item.episode_part,
        absolute_number: item.absolute_number,
        display_title_override: item.display_title_override,
        created_at: item.created_at,
        updated_at: item.updated_at,
      },
    };
  }
  getCollectionContextsByVideoIds(videoIds: number[]): Map<number, any> {
    return new Map(
      videoIds
        .map((id) => [id, this.getCollectionContextByVideoId(id)])
        .filter((entry): entry is [number, any] => entry[1] !== null)
    );
  }
  getNeighborsByVideoId(videoId: number): any | null {
    const context = this.getCollectionContextByVideoId(videoId);
    if (!context) return null;
    const entries = this.listCollectionEntries(context.collection_id);
    const index = entries.findIndex((entry) => entry.video_id === videoId);
    const map = (entry: any) =>
      entry
        ? {
            video_id: entry.video_id,
            entry_id: entry.id,
            title: entry.video.title,
            file_name: entry.video.file_name,
            display_title_override: entry.display_title_override,
            sequence_number: entry.sequence_number,
            season_number: entry.season_number,
            episode_number: entry.episode_number,
            episode_part: entry.episode_part,
            absolute_number: entry.absolute_number,
            thumbnail_id: entry.video.thumbnail_id,
            thumbnail_url: entry.video.thumbnail_url,
          }
        : null;
    return { previous: map(entries[index - 1]), next: map(entries[index + 1]) };
  }

  private mapSuggestion(item: any): any {
    return {
      id: Number(item.id),
      entity_type: item.entity_type,
      entity_id: Number(item.entity_id),
      creator_id:
        item.entity_type === "creator" ? Number(item.entity_id) : undefined,
      type: item.type,
      field_key: item.field_key,
      value: item.value,
      source: item.source,
      source_url: item.source_url,
      confidence: item.confidence,
      face_match_score: item.face_match_score,
      cached_preview_path: item.cached_preview_path,
      status: item.status,
      dedup_hash: item.dedup_hash,
      raw: parseJson(item.raw_json, null),
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
  getEnrichmentSuggestions(filters: any = {}): any[] {
    let list = this.rows("SELECT * FROM demo_enrichment_suggestions").map(
      (item) => this.mapSuggestion(item)
    );
    if (filters.entity_type)
      list = list.filter((item) => item.entity_type === filters.entity_type);
    if (filters.entity_id !== undefined)
      list = list.filter(
        (item) => item.entity_id === Number(filters.entity_id)
      );
    if (filters.status)
      list = list.filter((item) => item.status === filters.status);
    if (filters.type) list = list.filter((item) => item.type === filters.type);
    return list.sort(
      (a, b) =>
        (b.face_match_score ?? 0) - (a.face_match_score ?? 0) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        a.id - b.id
    );
  }
  getEnrichmentSuggestionById(id: number): any | null {
    const item = this.row(
      "SELECT * FROM demo_enrichment_suggestions WHERE id=?",
      id
    );
    return item ? this.mapSuggestion(item) : null;
  }
  getEnrichmentRuns(entityType: string, entityId: number): any[] {
    return this.rows(
      "SELECT * FROM demo_enrichment_runs WHERE entity_type=? AND entity_id=? ORDER BY started_at DESC",
      entityType,
      entityId
    ).map((item) => ({
      id: Number(item.id),
      entity_type: item.entity_type,
      entity_id: Number(item.entity_id),
      creator_id:
        item.entity_type === "creator" ? Number(item.entity_id) : undefined,
      status: item.status,
      sources_used: parseJson(item.sources_used_json, []),
      suggestion_count: Number(item.suggestion_count),
      errors: parseJson(item.errors_json, null),
      started_at: item.started_at,
      finished_at: item.finished_at,
    }));
  }
  runEnrichmentScan(
    entityType: string,
    entityId: number,
    sources: string[]
  ): any {
    const timestamp = now();
    const count = this.getEnrichmentSuggestions({
      entity_type: entityType,
      entity_id: entityId,
      status: "pending",
    }).length;
    const result = getDemoSqlite().run(
      "INSERT INTO demo_enrichment_runs (entity_type,entity_id,status,sources_used_json,suggestion_count,errors_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        entityType,
        entityId,
        "success",
        JSON.stringify(sources.length ? sources : ["theporndb"]),
        count,
        null,
        timestamp,
        timestamp,
      ]
    );
    return this.getEnrichmentRuns(entityType, entityId).find(
      (item) => item.id === Number(result.lastInsertRowid)
    );
  }
  decideEnrichmentSuggestion(id: number, status: "accepted" | "rejected"): any {
    const suggestion = this.getEnrichmentSuggestionById(id);
    if (!suggestion) {
      throw new NotFoundError(`Suggestion not found with id: ${id}`);
    }
    getDemoSqlite().run(
      "UPDATE demo_enrichment_suggestions SET status=?,updated_at=? WHERE id=?",
      [status, now(), id]
    );
    if (
      status === "accepted" &&
      suggestion.entity_type === "creator" &&
      suggestion.type === "bio"
    ) {
      getDemoSqlite().run(
        "UPDATE demo_creators SET description=?,updated_at=? WHERE id=?",
        [suggestion.value, now(), suggestion.entity_id]
      );
    }
    return this.getEnrichmentSuggestionById(id);
  }

  listResources(kind: string): any[] {
    return this.rows(
      "SELECT payload_json FROM demo_resources WHERE kind=? ORDER BY id",
      kind
    ).map((item) => parseJson(item.payload_json, {}));
  }
  getResource(kind: string, id: string | number): any | null {
    const item = this.row(
      "SELECT payload_json FROM demo_resources WHERE kind=? AND id=?",
      kind,
      String(id)
    );
    return item ? parseJson(item.payload_json, null) : null;
  }
  putResource(kind: string, id: string | number, payload: unknown): void {
    const timestamp = now();
    getDemoSqlite().run(
      "INSERT INTO demo_resources (kind,id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at",
      [kind, String(id), JSON.stringify(payload), timestamp, timestamp]
    );
  }
  deleteResource(kind: string, id: string | number): boolean {
    return (
      getDemoSqlite().run("DELETE FROM demo_resources WHERE kind=? AND id=?", [
        kind,
        String(id),
      ]).changes > 0
    );
  }
}

export const demoRepository = new DemoRepository();
