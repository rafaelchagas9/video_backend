export interface NotificationVideo {
  id: number;
  title: string | null;
  file_name: string;
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
