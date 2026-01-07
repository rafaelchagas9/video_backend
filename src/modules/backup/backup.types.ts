import { z } from "zod";

export interface BackupInfo {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ExportData {
  exportedAt: string;
  version: string;
  tables: {
    users: unknown[];
    directories: unknown[];
    videos: unknown[];
    creators: unknown[];
    tags: unknown[];
    ratings: unknown[];
    playlists: unknown[];
    favorites: unknown[];
    bookmarks: unknown[];
  };
}

export const restoreBackupSchema = z.object({
  filename: z.string().min(1),
});

export type RestoreBackupInput = z.infer<typeof restoreBackupSchema>;
