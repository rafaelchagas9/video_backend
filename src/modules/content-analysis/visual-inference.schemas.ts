import { z } from "zod";

export const VISION_CONTRACT_VERSION = "1" as const;
export const VISION_FACE_EMBEDDING_DIMENSION = 512;
export const VISION_NUDITY_CAPABILITY = "nudity" as const;
export const VISION_NUDITY_LABELS = [
  "BUTTOCKS_EXPOSED",
  "FEMALE_BREAST_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED",
  "MALE_BREAST_EXPOSED",
  "ANUS_EXPOSED",
  "FEET_EXPOSED",
  "ARMPITS_EXPOSED",
  "BELLY_EXPOSED",
  "MALE_GENITALIA_EXPOSED",
  "ANUS_COVERED",
  "FEMALE_GENITALIA_COVERED",
] as const;

const visionNudityLabelSet = new Set<string>(VISION_NUDITY_LABELS);

const finiteNumberSchema = z.number().finite();
const normalizedCoordinateSchema = finiteNumberSchema.min(0).max(1);

export const visionBoxSchema = z
  .object({
    space: z.literal("normalized"),
    x1: normalizedCoordinateSchema,
    y1: normalizedCoordinateSchema,
    x2: normalizedCoordinateSchema,
    y2: normalizedCoordinateSchema,
  })
  .superRefine((box, context) => {
    if (box.x2 < box.x1) {
      context.addIssue({
        code: "custom",
        path: ["x2"],
        message: "x2 must be greater than or equal to x1",
      });
    }
    if (box.y2 < box.y1) {
      context.addIssue({
        code: "custom",
        path: ["y2"],
        message: "y2 must be greater than or equal to y1",
      });
    }
  });

export const visionFindingSchema = z
  .object({
    capability: z.string().trim().min(1),
    label: z.string().trim().min(1),
    score: finiteNumberSchema.min(0).max(1),
    box: visionBoxSchema,
    embedding: z.array(finiteNumberSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((finding, context) => {
    if (finding.capability === "faces") {
      if (finding.label !== "face") {
        context.addIssue({
          code: "custom",
          path: ["label"],
          message: "face findings require the canonical face label",
        });
      }
      if (finding.embedding?.length !== VISION_FACE_EMBEDDING_DIMENSION) {
        context.addIssue({
          code: "custom",
          path: ["embedding"],
          message: `face findings require a ${VISION_FACE_EMBEDDING_DIMENSION}-position embedding`,
        });
      }
    }
    if (finding.capability === VISION_NUDITY_CAPABILITY) {
      if (!visionNudityLabelSet.has(finding.label)) {
        context.addIssue({
          code: "custom",
          path: ["label"],
          message: "nudity finding label is outside the canonical taxonomy",
        });
      }
      if (finding.embedding !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["embedding"],
          message: "nudity findings must not contain biometric embeddings",
        });
      }
    }
  });

export const visionItemErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string(),
});

export const visionCapabilityOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    capability: z.string().trim().min(1),
    status: z.literal("ok"),
    findings: z.array(visionFindingSchema),
  }),
  z.object({
    capability: z.string().trim().min(1),
    status: z.literal("error"),
    error: visionItemErrorSchema,
  }),
]);

export const visionBatchItemSchema = z.object({
  id: z.string().trim().min(1),
  timestampSeconds: finiteNumberSchema.nonnegative(),
  image: z.instanceof(Blob).refine((image) => image.size > 0, {
    message: "image must not be empty",
  }),
});

export const visionBatchSchema = z
  .object({
    capabilities: z.array(z.string().trim().min(1)).min(1),
    items: z.array(visionBatchItemSchema).min(1),
  })
  .superRefine((batch, context) => {
    if (new Set(batch.capabilities).size !== batch.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "capabilities must be unique",
      });
    }
    const ids = batch.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "item ids must be unique",
      });
    }
  });

export const visionBatchItemResultSchema = z
  .object({
    id: z.string().trim().min(1),
    timestampSeconds: finiteNumberSchema.nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    outcomes: z.array(visionCapabilityOutcomeSchema).min(1),
  })
  .superRefine((item, context) => {
    if ((item.width === undefined) !== (item.height === undefined)) {
      context.addIssue({
        code: "custom",
        path: [item.width === undefined ? "width" : "height"],
        message: "width and height must be returned together",
      });
    }
  });

export const visionBatchResultSchema = z.object({
  version: z.literal(VISION_CONTRACT_VERSION),
  items: z.array(visionBatchItemResultSchema),
});

export function validateVisionBatchResultForRequest(
  input: z.infer<typeof visionBatchSchema>,
  value: unknown
): z.infer<typeof visionBatchResultSchema> {
  const batch = visionBatchSchema.parse(input);
  const result = visionBatchResultSchema.parse(value);
  const expectedItems = new Map(
    batch.items.map((item) => [item.id, item.timestampSeconds])
  );
  if (result.items.length !== expectedItems.size) {
    throw new Error("Vision service did not echo the requested items");
  }
  const returnedIds = new Set<string>();
  for (const item of result.items) {
    if (
      returnedIds.has(item.id) ||
      expectedItems.get(item.id) !== item.timestampSeconds
    ) {
      throw new Error("Vision service did not echo the requested items");
    }
    returnedIds.add(item.id);
    const returnedCapabilities = item.outcomes.map(
      (outcome) => outcome.capability
    );
    if (
      returnedCapabilities.length !== batch.capabilities.length ||
      returnedCapabilities.some(
        (capability, index) => capability !== batch.capabilities[index]
      )
    ) {
      throw new Error(
        "Vision service did not return one outcome per requested capability"
      );
    }
    for (const outcome of item.outcomes) {
      if (
        (outcome.capability === "faces" ||
          outcome.capability === VISION_NUDITY_CAPABILITY) &&
        outcome.status === "ok" &&
        (item.width === undefined || item.height === undefined)
      ) {
        throw new Error(
          "Vision service omitted dimensions for a visual analysis result"
        );
      }
      if (
        outcome.status === "ok" &&
        outcome.findings.some(
          (finding) => finding.capability !== outcome.capability
        )
      ) {
        throw new Error(
          "Vision service returned a finding under the wrong capability"
        );
      }
    }
  }
  return result;
}

export const visionCapabilitySchema = z.object({
  name: z.string().trim().min(1),
  ready: z.boolean(),
  state: z.string().trim().min(1),
  providers: z.array(z.string()),
  modelRevision: z.string().nullable(),
  taxonomyRevision: z.string().nullable(),
  maxBatchItems: z.number().int().positive(),
  maxBatchBytes: z.number().int().positive(),
  maxImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
});

export const visionCapabilitiesSchema = z.object({
  version: z.literal(VISION_CONTRACT_VERSION),
  capabilities: z.array(visionCapabilitySchema),
});
