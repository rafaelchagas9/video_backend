import type { SettingValue } from "./settings.types";

export const DEFAULT_SETTINGS: Record<string, SettingValue> = {
  min_watch_seconds: 60,
  short_video_watch_seconds: 10,
  short_video_duration_seconds: 60,
  downscale_inactive_days: 90,
  watch_session_gap_minutes: 30,
  max_suggestions: 200,
  notifications_in_app_enabled: true,
  notifications_task_started: false,
  notifications_conversion_completed: true,
  notifications_conversion_failed: true,
  notifications_storyboard_ready: true,
  notifications_storyboard_failed: true,
  notifications_face_extraction_completed: true,
  notifications_face_extraction_failed: true,
};
