/**
 * Gallery pictures carry their pixel size so clients can filter them by
 * resolution and shape. Rows stored before sizes were recorded are measured
 * from the file's header on first read and saved, so it happens once.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  creatorGalleryMediaTable,
  type CreatorGalleryMedia as GalleryRow,
} from "@/database/schema";
import { readImageSize } from "@/utils/image-processing";
import { logger } from "@/utils/logger";

/** Fills in `width`/`height` for rows that lack them (0×0 when the file is unreadable). */
export async function withGallerySizes(rows: GalleryRow[]): Promise<GalleryRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.width !== null && row.height !== null) return row;
      let size = null;
      try {
        size = await readImageSize(await readFile(row.filePath));
      } catch (error) {
        logger.warn({ error, mediaId: row.id }, "Could not measure gallery picture");
      }
      const width = size?.width ?? 0;
      const height = size?.height ?? 0;
      await db
        .update(creatorGalleryMediaTable)
        .set({ width, height })
        .where(eq(creatorGalleryMediaTable.id, row.id));
      return { ...row, width, height };
    })
  );
}

/** The size fields of a gallery DTO: stored size, and the size it arrived at when known. */
export function gallerySizeFields(row: Pick<GalleryRow, "width" | "height" | "sourceWidth" | "sourceHeight">) {
  return {
    width: row.width || null,
    height: row.height || null,
    source_width: row.sourceWidth || null,
    source_height: row.sourceHeight || null,
  };
}
