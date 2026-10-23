/** The scene cover a video carries, as stored on disk. */
export interface VideoCover {
  video_id: number;
  /** Served copy; content-hashed, so it is safe to cache forever. */
  url: string;
  /** Where it came from (ThePornDB / StashDB CDN, or a data: URL from Stash). */
  source_url: string;
  width: number;
  height: number;
  file_size_bytes: number;
  /** Wide enough to stand in for the ffmpeg thumbnail. */
  serves_thumbnail: boolean;
  fetched_at: string;
}
