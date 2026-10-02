/**
 * Measures `image` proposals in the background so reviews can filter them by
 * resolution and shape without downloading every picture. A scan hands over
 * what it inserted; a read hands over anything still unmeasured (rows from
 * before sizes were recorded). Each picture is probed once: a failure is
 * stored as 0×0 so it is not retried on every read.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { enrichmentSuggestionsTable } from "@/database/schema";
import { logger } from "@/utils/logger";
import { probeEnrichmentImage } from "./enrichment.images";

const LANES = 4;

class ImageSizeProbe {
  private readonly queued = new Set<number>();
  private readonly waiting: number[] = [];
  private active = 0;

  /** Queue proposals for measuring; ids already queued or measured are skipped. */
  measure(ids: number[]): void {
    for (const id of ids) {
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.waiting.push(id);
    }
    while (this.active < LANES && this.waiting.length) {
      this.active += 1;
      void this.lane().finally(() => {
        this.active -= 1;
      });
    }
  }

  private async lane(): Promise<void> {
    for (
      let id = this.waiting.shift();
      id !== undefined;
      id = this.waiting.shift()
    ) {
      try {
        await this.measureOne(id);
      } catch (error) {
        logger.warn({ error, suggestionId: id }, "Image proposal probe failed");
      } finally {
        this.queued.delete(id);
      }
    }
  }

  private async measureOne(id: number): Promise<void> {
    const [row] = await db
      .select({ value: enrichmentSuggestionsTable.value })
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.id, id),
          eq(enrichmentSuggestionsTable.type, "image"),
          isNull(enrichmentSuggestionsTable.imageWidth)
        )
      );
    if (!row) return;
    const size = await probeEnrichmentImage(row.value);
    await db
      .update(enrichmentSuggestionsTable)
      .set({ imageWidth: size?.width ?? 0, imageHeight: size?.height ?? 0 })
      .where(eq(enrichmentSuggestionsTable.id, id));
  }
}

export const imageSizeProbe = new ImageSizeProbe();
