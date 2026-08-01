import { demoRepository } from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import type {
  EntityType,
  RunDTO,
  RunEnrichmentOptions,
  SuggestionDTO,
} from "./enrichment.types";

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
    return demoRepository.decideEnrichmentSuggestion(
      id,
      "accepted"
    ) as SuggestionDTO;
  }

  async rejectSuggestion(id: number): Promise<SuggestionDTO> {
    this.assertSuggestionExists(id);
    return demoRepository.decideEnrichmentSuggestion(
      id,
      "rejected"
    ) as SuggestionDTO;
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
