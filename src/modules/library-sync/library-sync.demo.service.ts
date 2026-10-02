import { asc, eq } from "drizzle-orm";
import { getDemoDatabase } from "@/database/demo/client";
import { demoVideosTable } from "@/database/demo/schema";
import { buildDemoCopyResults } from "./library-sync.demo.fixtures";

export function demoCopyResults(input: {
  limit: number;
  offset: number;
  view?: "copies" | "similarity";
}) {
  const videos = getDemoDatabase()
    .select({
      id: demoVideosTable.id,
      durationSeconds: demoVideosTable.durationSeconds,
      title: demoVideosTable.title,
      fileName: demoVideosTable.fileName,
    })
    .from(demoVideosTable)
    .where(eq(demoVideosTable.isAvailable, true))
    .orderBy(asc(demoVideosTable.id))
    .all();
  return buildDemoCopyResults(videos, input);
}
