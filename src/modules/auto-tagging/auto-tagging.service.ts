import { db } from "@/config/drizzle";
import { eq, sql } from "drizzle-orm";
import {
  videoTagsTable,
  videoCreatorsTable,
  videoStudiosTable,
  creatorsTable,
  studiosTable,
} from "@/database/schema";
import { logger } from "@/utils/logger";
import { taggingRulesService } from "../tagging-rules/tagging-rules.service";
import { parseVideoPath } from "@/utils/path-parser";

export interface AutoTagResult {
  video_id: number;
  file_path: string;
  creators_added: number;
  studios_added: number;
  tags_added: number;
  matched_rules: string[];
}

export class AutoTaggingService {
  async tagNewVideo(videoId: number, filePath: string): Promise<AutoTagResult> {
    const result: AutoTagResult = {
      video_id: videoId,
      file_path: filePath,
      creators_added: 0,
      studios_added: 0,
      tags_added: 0,
      matched_rules: [],
    };

    try {
      const rules = await taggingRulesService.list(false);
      if (rules.length === 0) {
        return result;
      }

      const pathResult = parseVideoPath(filePath);

      for (const rule of rules) {
        const conditions = rule.conditions || [];
        const actions = rule.actions || [];

        if (conditions.length === 0 || actions.length === 0) {
          continue;
        }

        const matchedConditions = this.evaluateConditionsForVideo(
          filePath,
          pathResult,
          conditions,
        );

        if (matchedConditions.length > 0) {
          result.matched_rules.push(rule.name);

          for (const action of actions) {
            const actionResult = await this.applyActionForVideo(
              videoId,
              action,
              filePath,
              pathResult,
            );
            if (actionResult.success) {
              if (actionResult.type === "creator") result.creators_added++;
              if (actionResult.type === "studio") result.studios_added++;
              if (actionResult.type === "tag") result.tags_added++;
            }
          }
        }
      }

      if (
        result.creators_added > 0 ||
        result.studios_added > 0 ||
        result.tags_added > 0
      ) {
        logger.info(
          {
            video_id: videoId,
            creators_added: result.creators_added,
            studios_added: result.studios_added,
            tags_added: result.tags_added,
          },
          `Auto-tagged video with ${result.creators_added} creators, ${result.studios_added} studios, ${result.tags_added} tags`,
        );
      }

      return result;
    } catch (error) {
      logger.warn(
        { error, video_id: videoId, file_path: filePath },
        "Failed to auto-tag video",
      );
      return result;
    }
  }

  async tagMultipleVideos(videoIds: number[]): Promise<AutoTagResult[]> {
    const results: AutoTagResult[] = [];

    for (const videoId of videoIds) {
      const videosResult = await db.execute(
        sql`SELECT id, file_path FROM videos WHERE id = ${videoId}`,
      );
      const videos = videosResult as any[];

      if (videos.length > 0) {
        const video = videos[0];
        const result = await this.tagNewVideo(video.id, video.file_path);
        results.push(result);
      }
    }

    return results;
  }

  private evaluateConditionsForVideo(
    filePath: string,
    pathResult: ReturnType<typeof parseVideoPath>,
    conditions: Array<{
      condition_type: string;
      operator: string;
      value: string;
    }>,
  ): string[] {
    const matched: string[] = [];

    for (const condition of conditions) {
      let matches = false;

      switch (condition.condition_type) {
        case "path_pattern":
        case "file_pattern":
          try {
            const regex = new RegExp(condition.value);
            matches = regex.test(filePath);
          } catch {
            matches = false;
          }
          break;

        case "resolution":
          if (
            pathResult.extracted.tags.some((t) =>
              ["4K", "1080p", "720p", "480p", "360p"].includes(t.toUpperCase()),
            )
          ) {
            matches =
              condition.value.toUpperCase() ===
              pathResult.extracted.tags
                .find((t) =>
                  ["4K", "1080p", "720p", "480p", "360p"].includes(
                    t.toUpperCase(),
                  ),
                )
                ?.toUpperCase();
          }
          const resolutionMatch = filePath.match(/(\d{3,4})x(\d{3,4})/i);
          if (resolutionMatch) {
            const targetResolutions: Record<
              string,
              { width: number; height: number }
            > = {
              "4K": { width: 3840, height: 2160 },
              "1080P": { width: 1920, height: 1080 },
              "720P": { width: 1280, height: 720 },
              "480P": { width: 854, height: 480 },
              "360P": { width: 640, height: 360 },
            };
            const target = targetResolutions[condition.value.toUpperCase()];
            if (target) {
              const width = parseInt(resolutionMatch[1]);
              const height = parseInt(resolutionMatch[2]);
              matches = width === target.width && height === target.height;
            }
          }
          break;

        case "codec":
          const lowerValue = condition.value.toLowerCase();
          matches = filePath.toLowerCase().includes(lowerValue);
          break;

        case "file_pattern":
          matches = filePath
            .toLowerCase()
            .includes(condition.value.toLowerCase());
          break;

        default:
          matches = false;
      }

      if (matches) {
        matched.push(
          `${condition.condition_type} ${condition.operator} ${condition.value}`,
        );
      }
    }

    return matched;
  }

  private async applyActionForVideo(
    videoId: number,
    action: {
      action_type: string;
      target_id: number | null;
      target_name: string | null;
      dynamic_value: string | null;
    },
    _filePath: string,
    pathResult: ReturnType<typeof parseVideoPath>,
  ): Promise<{ success: boolean; type: "creator" | "studio" | "tag" }> {
    try {
      switch (action.action_type) {
        case "add_tag":
          if (action.target_id) {
            await db
              .insert(videoTagsTable)
              .values({ videoId, tagId: action.target_id })
              .onConflictDoNothing();
            return { success: true, type: "tag" };
          }
          break;

        case "add_creator":
          if (action.dynamic_value?.startsWith("$")) {
            const groupName = action.dynamic_value.slice(1);
            const creatorName =
              pathResult.extracted.creator ||
              (pathResult.extracted as any)[groupName];
            if (creatorName) {
              const existingCreator = await db
                .select()
                .from(creatorsTable)
                .where(eq(creatorsTable.name, creatorName));

              let creatorId: number;
              if (existingCreator.length === 0) {
                const result = await db
                  .insert(creatorsTable)
                  .values({ name: creatorName })
                  .returning({ id: creatorsTable.id });
                creatorId = result[0].id;
              } else {
                creatorId = existingCreator[0].id;
              }

              await db
                .insert(videoCreatorsTable)
                .values({ videoId, creatorId })
                .onConflictDoNothing();
              return { success: true, type: "creator" };
            }
          } else if (action.target_id) {
            await db
              .insert(videoCreatorsTable)
              .values({ videoId, creatorId: action.target_id })
              .onConflictDoNothing();
            return { success: true, type: "creator" };
          }
          break;

        case "add_studio":
          if (action.dynamic_value?.startsWith("$")) {
            const groupName = action.dynamic_value.slice(1);
            const studioName =
              pathResult.extracted.studio ||
              (pathResult.extracted as any)[groupName];
            if (studioName) {
              const existingStudio = await db
                .select()
                .from(studiosTable)
                .where(eq(studiosTable.name, studioName));

              let studioId: number;
              if (existingStudio.length === 0) {
                const result = await db
                  .insert(studiosTable)
                  .values({ name: studioName })
                  .returning({ id: studiosTable.id });
                studioId = result[0].id;
              } else {
                studioId = existingStudio[0].id;
              }

              await db
                .insert(videoStudiosTable)
                .values({ videoId, studioId })
                .onConflictDoNothing();
              return { success: true, type: "studio" };
            }
          } else if (action.target_id) {
            await db
              .insert(videoStudiosTable)
              .values({ videoId, studioId: action.target_id })
              .onConflictDoNothing();
            return { success: true, type: "studio" };
          }
          break;
      }

      return { success: false, type: "tag" };
    } catch {
      return { success: false, type: "tag" };
    }
  }
}

export const autoTaggingService = new AutoTaggingService();
