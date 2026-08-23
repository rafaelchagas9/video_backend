import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { env } from "@/config/env";
import { EditsService, validateEditRequest } from "@/modules/edits/edits.service";
import type {
  CreateEditJobInput,
  EditJob,
  EditJobStatus,
} from "@/modules/edits/edits.types";
import { ConflictError, NotFoundError } from "@/utils/errors";

const storedTimeline = {
  segments: [{ start: 2, end: 10, speed: 1 }],
  audio: { volume: 0.8 },
};

const normalizedStoredTimeline = {
  ...storedTimeline,
  audio: {
    muted: false,
    volume: 0.8,
    fade_in_seconds: 0,
    fade_out_seconds: 0,
  },
};

function sourceJob(status: EditJobStatus): EditJob {
  return {
    id: 41,
    videoId: 17,
    status,
    progress: status === "completed" ? 100 : 0,
    outputConfig: {
      directory_id: 3,
      file_name: "historical-name.mkv",
      format: "mkv",
      video_codec: "av1",
      audio_codec: "opus",
    },
    timelineConfig: storedTimeline,
    outputPath: "/private/library/historical-name.mkv",
    outputVideoId: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const output: CreateEditJobInput["output"] = {
  directory_id: 8,
  file_name: "new-target.mkv",
  format: "mkv",
  video_codec: "av1",
  audio_codec: "aac",
};

describe("EditsService clone production path", () => {
  let originalDemoMode: boolean;

  beforeAll(() => {
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = false;
  });

  afterAll(() => {
    env.DEMO_MODE = originalDemoMode;
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`delegates a ${status} recipe to the canonical create path`, async () => {
      const service = new EditsService();
      const getSpy = spyOn(service, "getById").mockResolvedValue(sourceJob(status));
      const created = { ...sourceJob("queued"), id: 99, outputConfig: output };
      const createSpy = spyOn(service, "create").mockResolvedValue(created);

      try {
        await expect(service.clone(41, { output })).resolves.toBe(created);
        expect(getSpy).toHaveBeenCalledWith(41);
        expect(createSpy).toHaveBeenCalledWith(17, {
          output,
          timeline: normalizedStoredTimeline,
        });
      } finally {
        getSpy.mockRestore();
        createSpy.mockRestore();
      }
    });
  }

  it("uses an edited timeline instead of the stored timeline", async () => {
    const service = new EditsService();
    const override = { segments: [{ start: 0, end: 4, speed: 2 }] };
    const getSpy = spyOn(service, "getById").mockResolvedValue(
      sourceJob("completed")
    );
    const createSpy = spyOn(service, "create").mockResolvedValue({
      ...sourceJob("queued"),
      id: 100,
      outputConfig: output,
      timelineConfig: override,
    });

    try {
      await service.clone(41, { output, timeline: override });
      expect(createSpy).toHaveBeenCalledWith(17, {
        output,
        timeline: override,
      });
    } finally {
      getSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("preserves missing-source and active-job errors without creating a job", async () => {
    const missingService = new EditsService();
    const missingGet = spyOn(missingService, "getById").mockRejectedValue(
      new NotFoundError("Edit job not found with id: 404")
    );
    const missingCreate = spyOn(missingService, "create");
    try {
      await expect(missingService.clone(404, { output })).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(missingCreate).not.toHaveBeenCalled();
    } finally {
      missingGet.mockRestore();
      missingCreate.mockRestore();
    }

    const activeService = new EditsService();
    const activeGet = spyOn(activeService, "getById").mockResolvedValue(
      sourceJob("running")
    );
    const activeCreate = spyOn(activeService, "create");
    try {
      await expect(activeService.clone(41, { output })).rejects.toMatchObject({
        statusCode: 409,
        message: "Only terminal edit jobs can be cloned",
      });
      expect(activeCreate).not.toHaveBeenCalled();
    } finally {
      activeGet.mockRestore();
      activeCreate.mockRestore();
    }
  });

  it("propagates current output collision and duration revalidation failures", async () => {
    const collisionService = new EditsService();
    const collisionGet = spyOn(collisionService, "getById").mockResolvedValue(
      sourceJob("completed")
    );
    const collisionCreate = spyOn(collisionService, "create").mockRejectedValue(
      new ConflictError("Output file already exists: new-target.mkv")
    );
    try {
      await expect(
        collisionService.clone(41, { output })
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      collisionGet.mockRestore();
      collisionCreate.mockRestore();
    }

    const durationService = new EditsService();
    const durationGet = spyOn(durationService, "getById").mockResolvedValue(
      sourceJob("completed")
    );
    const durationCreate = spyOn(durationService, "create").mockImplementation(
      async (_videoId, input) => {
        validateEditRequest(input, 5);
        throw new Error("Expected current-duration validation to reject");
      }
    );
    try {
      await expect(durationService.clone(41, { output })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("exceeds the source duration"),
      });
      expect(durationCreate).toHaveBeenCalledWith(17, {
        output,
        timeline: normalizedStoredTimeline,
      });
    } finally {
      durationGet.mockRestore();
      durationCreate.mockRestore();
    }
  });
});
