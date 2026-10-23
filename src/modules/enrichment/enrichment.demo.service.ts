import { demoRepository } from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import { demoSceneFixture } from "@/database/demo/scene-credits";
import { sourceCoversDemoService } from "@/modules/source-covers/source-covers.demo.service";
import { videosDemoService } from "@/modules/videos/videos.demo.service";
import type {
  EntityType,
  RunDTO,
  RunEnrichmentOptions,
  SceneResetDTO,
  SuggestionDTO,
} from "./enrichment.types";
import type { RelatedKind, ResolutionPreview } from "./enrichment.service";

export interface DemoSuggestionFilters {
  entity_type?: EntityType;
  entity_id?: number;
  status?: string;
  type?: string;
}

/**
 * Local enrichment simulation over seeded SQLite suggestions.
 * Running discovery records a deterministic local run and never calls TPDB,
 * StashDB, the Python enrichment service, or any network client.
 */
export class EnrichmentDemoService {
  async runEnrichment(
    entityType: EntityType,
    entityId: number,
    options: RunEnrichmentOptions = {}
  ): Promise<RunDTO> {
    this.assertEntityExists(entityType, entityId);
    return demoRepository.runEnrichmentScan(
      entityType,
      entityId,
      options.sources ?? ["theporndb"]
    ) as RunDTO;
  }

  async listSuggestions(
    filters: DemoSuggestionFilters = {}
  ): Promise<SuggestionDTO[]> {
    return demoRepository.getEnrichmentSuggestions(filters) as SuggestionDTO[];
  }

  async listRuns(entityType: EntityType, entityId: number): Promise<RunDTO[]> {
    return demoRepository.getEnrichmentRuns(entityType, entityId) as RunDTO[];
  }

  async acceptSuggestion(id: number): Promise<SuggestionDTO> {
    this.assertSuggestionExists(id);
    const suggestion = demoRepository.decideEnrichmentSuggestion(
      id,
      "accepted"
    ) as SuggestionDTO;
    if (suggestion.entity_type === "scene") await this.applyScene(suggestion);
    return suggestion;
  }

  /** Details, links and the cover land on the demo video; credits are judged on these. */
  private async applyScene(s: SuggestionDTO): Promise<void> {
    const videoId = s.entity_id;
    switch (s.type) {
      case "field":
        if (s.field_key === "title" || s.field_key === "description") {
          videosDemoService.update(videoId, { [s.field_key]: s.value });
        } else if (s.field_key) {
          videosDemoService.setMetadata(videoId, s.field_key, s.value);
        }
        break;
      case "image":
        videosDemoService.setMetadata(videoId, "cover_image_url", s.value);
        await sourceCoversDemoService.assign(videoId, s.value);
        break;
      case "external_id":
        demoRepository.putResource("video-external-id", `${videoId}:${s.source}`, {
          source: s.source,
          external_id: s.value,
          url: s.source_url ?? null,
          last_synced_at: new Date().toISOString(),
        });
        break;
    }
  }

  async rejectSuggestion(id: number): Promise<SuggestionDTO> {
    this.assertSuggestionExists(id);
    return demoRepository.decideEnrichmentSuggestion(
      id,
      "rejected"
    ) as SuggestionDTO;
  }

  async resetScene(entityId: number): Promise<SceneResetDTO> {
    this.assertEntityExists("scene", entityId);
    const cleared = demoRepository.clearEnrichment("scene", entityId);
    // The fixture's credits are its baseline; a reset only drops what a scan added.
    if (!demoSceneFixture().some((scene) => scene.video_id === entityId && scene.cover)) {
      videosDemoService.deleteMetadata(entityId, "cover_image_url");
      sourceCoversDemoService.clear(entityId);
    }
    return { suggestions_cleared: cleared, fields_cleared: [], links_removed: 0 };
  }

  async previewResolution(
    entityType: EntityType,
    entityId: number
  ): Promise<ResolutionPreview[]> {
    const kinds: Record<string, RelatedKind> = { performer: "creator", studio: "studio", tag: "tag" };
    return this.listSuggestions({ entity_type: entityType, entity_id: entityId, status: "pending" }).then((rows) =>
      rows.flatMap((row) => {
        const kind = kinds[row.type];
        return kind
          ? [
              {
                suggestion_id: row.id,
                kind,
                match: demoRepository.findRelatedEntity(kind, row.value),
                ambiguous: [],
                requires_choice: null,
              },
            ]
          : [];
      })
    );
  }

  private assertSuggestionExists(id: number): void {
    if (!demoRepository.getEnrichmentSuggestionById(id)) {
      throw new NotFoundError(`Enrichment suggestion not found: ${id}`);
    }
  }

  private assertEntityExists(entityType: EntityType, entityId: number): void {
    try {
      switch (entityType) {
        case "creator":
          demoRepository.getCreatorById(entityId);
          break;
        case "studio":
          demoRepository.getStudioById(entityId);
          break;
        case "scene":
          demoRepository.getVideoById(entityId);
          break;
        case "tag":
          if (!demoRepository.getTags().some((tag) => tag.id === entityId)) {
            throw new Error("missing tag");
          }
          break;
      }
    } catch {
      throw new NotFoundError(
        `Enrichment ${entityType} not found: ${entityId}`
      );
    }
  }
}

export const enrichmentDemoService = new EnrichmentDemoService();
