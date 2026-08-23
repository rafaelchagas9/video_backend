import { z } from "zod";

export const createDirectorySchema = z.object({
  path: z.string().min(1),
  auto_scan: z.boolean().default(true),
  scan_interval_minutes: z.number().int().positive().default(30),
});

export const updateDirectorySchema = z.object({
  is_active: z.boolean().optional(),
  auto_scan: z.boolean().optional(),
  scan_interval_minutes: z.number().int().positive().optional(),
});

export type CreateDirectoryInput = z.infer<typeof createDirectorySchema>;
export type UpdateDirectoryInput = z.infer<typeof updateDirectorySchema>;

export interface Directory {
  id: number;
  path: string;
  is_active: boolean;
  auto_scan: boolean;
  scan_interval_minutes: number;
  last_scan_at: string | null;
  added_at: string;
  updated_at: string;
}

export interface DirectoryStats {
  directory_id: number;
  total_videos: number;
  total_size_bytes: number;
  available_videos: number;
  unavailable_videos: number;
}

export interface ScanRun {
  id: number;
  directory_id: number;
  status: "running" | "completed";
  files_found: number;
  files_added: number;
  files_updated: number;
  files_removed: number;
  error_count: number;
  error_summaries: string[];
  started_at: string;
  completed_at: string | null;
}

export interface ScanResult {
  files_found: number;
  files_added: number;
  files_updated: number;
  files_removed: number;
  errors: string[];
}

export interface ScanRunPage {
  data: ScanRun[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface SchedulerStatus {
  is_running: boolean;
  scheduled_directories: number;
  schedules: Array<{
    directory_id: number;
    interval_minutes: number;
  }>;
  system_tasks: Array<{
    name: string;
    cron_expression: string;
  }>;
}
