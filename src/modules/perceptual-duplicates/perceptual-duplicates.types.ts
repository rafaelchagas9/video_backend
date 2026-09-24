import type { DurableJobStatus } from "@/modules/durable-jobs";
import type { PerceptualDuplicatesEngineResult } from "./perceptual-duplicates.schemas";

export interface PerceptualDuplicatesJobView {
  id: number;
  userId: number;
  videoIds: number[];
  status: DurableJobStatus;
  phase:
    "queued" | "preparing" | "comparing" | "completed" | "failed" | "cancelled";
  completedUnits: number;
  totalUnits: number;
  result: PerceptualDuplicatesEngineResult | null;
  error: { code: string; message: string } | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

export interface StartPerceptualDuplicatesInput {
  userId: number;
  videoIds: number[];
}

export interface PerceptualDuplicatesServiceContract {
  start(input: StartPerceptualDuplicatesInput): Promise<{
    job: PerceptualDuplicatesJobView;
    reused: boolean;
  }>;
  get(jobId: number, userId: number): Promise<PerceptualDuplicatesJobView>;
  cancel(jobId: number, userId: number): Promise<PerceptualDuplicatesJobView>;
}
