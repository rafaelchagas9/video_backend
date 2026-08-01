export interface NotificationVideo {
  id: number;
  title: string | null;
  file_name: string;
}

export type SseEventType =
  | "artwork:generating"
  | "artwork:ready"
  | "artwork:error"
  | (string & {});

export interface ArtworkEventMessage {
  videoId: number;
  video_id: number;
  videoTitle?: string;
  video_title?: string;
  fileName?: string;
  file_name?: string;
  variants?: Array<"card" | "poster" | "square" | "hero" | "title">;
  progress?: number;
  error?: string;
}

export function createVideoEventContext(video: NotificationVideo) {
  const videoTitle = video.title?.trim() || video.file_name;

  return {
    videoId: video.id,
    video_id: video.id,
    videoTitle,
    video_title: videoTitle,
    fileName: video.file_name,
    file_name: video.file_name,
  };
}
