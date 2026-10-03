/**
 * Demo mode stand-ins for the Stash bridge and batch identify. They live in
 * process memory, never reach PostgreSQL, Python or Stash, and say plainly
 * that no external source was consulted.
 */

import { NotFoundError, ConflictError } from "@/utils/errors";
import type {
  IdentifyCounts,
  IdentifyFilter,
  IdentifyItemDTO,
  IdentifyOptions,
  IdentifyRunDTO,
} from "@/modules/enrichment/enrichment.identify.service";
import type { StashStatusDTO } from "./stash-link.service";

const DEMO_REASON = "Demo mode: no external source was consulted";

interface DemoJob {
  id: number;
  kind: string;
  status: string;
  checkpoint: unknown;
  lastError: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

class StashDemo {
  private jobs = new Map<number, DemoJob>();
  private runs = new Map<number, IdentifyRunDTO>();
  private items = new Map<number, IdentifyItemDTO[]>();
  private nextId = 1;

  status(): StashStatusDTO & { demo: true } {
    return {
      demo: true,
      configured: true,
      reachable: true,
      version: "demo",
      stash_boxes: [
        { endpoint: "https://stashdb.org/graphql", name: "StashDB", provider_id: "stashdb" },
        { endpoint: "https://theporndb.net/graphql", name: "ThePornDB", provider_id: "theporndb" },
      ],
      library_paths: ["/demo"],
      coverage: { videos: 0, linked: 0, with_phash: 0, pre_conversion_hashes: 0 },
    };
  }

  enqueueSync(videoIds: number[] = []): DemoJob {
    const now = new Date();
    const job: DemoJob = {
      id: this.nextId++,
      kind: "stash.sync",
      status: "completed",
      checkpoint: { stage: "link", completedUnits: videoIds.length, totalUnits: videoIds.length },
      lastError: null,
      createdAt: now,
      completedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: number): DemoJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundError(`Job not found: ${id}`);
    return job;
  }

  submit(videoIds: number[]) {
    return { submitted: true, video_ids: videoIds, skipped: [] as number[], demo: true };
  }

  startIdentify(filter: IdentifyFilter, options: IdentifyOptions, dryRun: boolean): IdentifyRunDTO {
    const videoIds = filter.video_ids ?? [];
    const now = new Date().toISOString();
    const counts: IdentifyCounts = {
      total: videoIds.length,
      processed: videoIds.length,
      applied: 0,
      queued: 0,
      no_match: videoIds.length,
      unlinked: 0,
      errors: 0,
    };
    const { video_ids: _ids, ...rest } = filter;
    const run: IdentifyRunDTO = {
      id: this.nextId++,
      status: "completed",
      dry_run: dryRun,
      options,
      filter: { ...rest, video_count: videoIds.length },
      counts,
      error: null,
      created_at: now,
      started_at: now,
      finished_at: now,
    };
    this.runs.set(run.id, run);
    this.items.set(
      run.id,
      videoIds.map((videoId, index) => ({
        id: index + 1,
        video_id: videoId,
        outcome: "no_match",
        source: null,
        external_id: null,
        detail: { reason: DEMO_REASON },
        created_at: now,
      }))
    );
    return run;
  }

  listRuns(): IdentifyRunDTO[] {
    return [...this.runs.values()].reverse();
  }

  getRun(id: number): IdentifyRunDTO {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError(`Identify run not found: ${id}`);
    return run;
  }

  listItems(id: number, query: { outcome?: string; page: number; per_page: number }) {
    this.getRun(id);
    const all = (this.items.get(id) ?? []).filter((item) => !query.outcome || item.outcome === query.outcome);
    const start = (query.page - 1) * query.per_page;
    return { items: all.slice(start, start + query.per_page), total: all.length };
  }

  cancel(id: number): IdentifyRunDTO {
    const run = this.getRun(id);
    throw new ConflictError(`Run ${id} is already ${run.status}`);
  }

  refreshReport() {
    return { checked: 0, merged: [], deleted: [], duplicates: [], unsupported: [], errors: [], demo: true };
  }
}

export const stashDemo = new StashDemo();
