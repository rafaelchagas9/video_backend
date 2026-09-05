import { desc, isNull, ne, or } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { conversionHistoryTable } from "@/database/schema";
import { buildConversionCalibration } from "./conversion.estimator";

async function loadCalibration() {
  const rows = await db
    .select({
      preset: conversionHistoryTable.preset,
      profileVersion: conversionHistoryTable.profileVersion,
      sourceBitrate: conversionHistoryTable.sourceBitrate,
      sourceCodec: conversionHistoryTable.sourceCodec,
      outputWidth: conversionHistoryTable.outputWidth,
      outputHeight: conversionHistoryTable.outputHeight,
      originalSizeBytes: conversionHistoryTable.originalSizeBytes,
      outputSizeBytes: conversionHistoryTable.outputSizeBytes,
    })
    .from(conversionHistoryTable)
    // Software CRF jobs do not calibrate the hardware VBR plan used for new jobs.
    .where(
      or(
        isNull(conversionHistoryTable.encodingMode),
        ne(conversionHistoryTable.encodingMode, "full_sw")
      )
    )
    .orderBy(desc(conversionHistoryTable.createdAt))
    .limit(20_000);
  return {
    calibration: buildConversionCalibration(
      rows.map((row) => ({
        ...row,
        originalSizeBytes: Number(row.originalSizeBytes),
        outputSizeBytes: Number(row.outputSizeBytes),
      }))
    ),
    historyCount: rows.length,
  };
}

/** Share one bounded history read across suggestions and interactive preflight. */
export class ConversionCalibrationService {
  private pending: ReturnType<typeof loadCalibration> | undefined;
  private expiresAt = 0;
  constructor(
    private readonly load = loadCalibration,
    private readonly clock = Date.now
  ) {}
  get(): ReturnType<typeof loadCalibration> {
    if (!this.pending || this.clock() >= this.expiresAt) {
      const pending = this.load();
      this.pending = pending;
      this.expiresAt = this.clock() + 60_000;
      pending.catch(() => {
        if (this.pending === pending) this.invalidate();
      });
    }
    return this.pending;
  }
  invalidate(): void {
    this.pending = undefined;
    this.expiresAt = 0;
  }
}

export const conversionCalibrationService = new ConversionCalibrationService();
