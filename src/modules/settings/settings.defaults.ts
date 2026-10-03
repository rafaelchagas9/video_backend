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
  library_sync_auto_perceptual: false,
  // Enrichment candidate rules (see enrichment.policy.ts). Empty genders = all.
  enrichment_performer_genders: "",
  enrichment_exclude_tag_patterns: "",
  enrichment_skip_single_name_performers: true,
  // Batch identify defaults, a JSON IdentifyOptions document.
  identify_options: "",
  // Link new and converted videos to their Stash scenes automatically.
  stash_auto_sync: true,
  // Live recordings (goondvr). Prompts are newline-separated SigLIP descriptions; the
  // directory is the watched folder holding finished recordings (0 = detect by path).
  recordings_directory_id: 0,
  recordings_highlight_prompts:
    "nude woman\nsex scene\nclose-up of genitals\nwoman undressing\nmasturbation\ntopless woman\nusing a sex toy\nwoman in lingerie posing",
  recordings_idle_prompts:
    "woman talking to the camera, fully clothed\nempty room\nblack screen\nstream offline placeholder\nwoman looking at her phone",
  recordings_sensitivity: 1.4,
};
