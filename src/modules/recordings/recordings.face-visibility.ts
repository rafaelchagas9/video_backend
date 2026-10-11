/** Numeric detection-only observations from Kura's existing shared vision service. */
import { z } from "zod";
import { HttpVisualInferenceAdapter, type HttpVisualInferenceAdapterOptions } from "@/modules/content-analysis/visual-inference.http.adapter";

export const RECORDING_FACE_VISIBILITY_MODEL_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91";
const policySchema = z.object({
  model_sha256: z.literal(RECORDING_FACE_VISIBILITY_MODEL_SHA256),
  input_size: z.tuple([z.literal(640), z.literal(640)]), confidence: z.literal(.5), nms: z.literal(.4),
  providers: z.array(z.string().min(1)).min(1).refine(p => p.some(name => ["MIGraphXExecutionProvider", "CUDAExecutionProvider", "ROCMExecutionProvider", "TensorrtExecutionProvider", "DmlExecutionProvider"].includes(name))),
  identity_embeddings: z.literal(false), service: z.literal("shared-vision"),
});
const observationSchema = policySchema.extend({
  detected: z.boolean(), max_confidence: z.number().finite().min(0).max(1),
}).refine(o => o.detected ? o.max_confidence >= .5 : o.max_confidence === 0);
export type RecordingFaceVisibilityPolicy = z.infer<typeof policySchema>;
export interface RecordingFaceVisibilityItem { index: number; timestampSeconds: number; image: Blob }
export interface RecordingFaceVisibilityFrame {
  index: number; timestamp: number; detected: boolean | null; max_confidence: number | null;
  policy?: RecordingFaceVisibilityPolicy; error?: string;
}
export interface RecordingFaceVisibilityResult {
  generationIdentity: string; frames: RecordingFaceVisibilityFrame[];
  policy: RecordingFaceVisibilityPolicy | null;
}
export class HttpRecordingFaceVisibilityAdapter {
  private readonly client: HttpVisualInferenceAdapter;
  constructor(options: HttpVisualInferenceAdapterOptions) {
    this.client = new HttpVisualInferenceAdapter({ ...options, timeoutMs: options.timeoutMs ?? 120_000, analyzePath: "/v1/face-visibility" });
  }
  async observe(input: { generationIdentity: string; items: RecordingFaceVisibilityItem[] }, signal: AbortSignal): Promise<RecordingFaceVisibilityResult> {
    if (!/^[a-f0-9]{64}$/.test(input.generationIdentity) || !input.items.length || input.items.length > 8000 || new Set(input.items.map(p => p.index)).size !== input.items.length || input.items.some(p => !Number.isInteger(p.index) || p.index < 0 || !Number.isFinite(p.timestampSeconds) || p.timestampSeconds < 0 || !(p.image instanceof Blob) || !p.image.size)) throw new Error("Exact generation and unique numeric frame indices required");
    const frames: RecordingFaceVisibilityFrame[] = [];
    let policy: RecordingFaceVisibilityPolicy | null = null;
    // The server enforces stricter deployed limits. Keep sequential batches bounded
    // even when an injected transport has no capability endpoint.
    for (let start = 0; start < input.items.length; start += 16) {
      signal.throwIfAborted();
      const items = input.items.slice(start, start + 16);
      if (items.reduce((sum, p) => sum + p.image.size, 0) > 32 * 1024 * 1024 || items.some(p => p.image.size > 10 * 1024 * 1024)) throw new Error("Face visibility image batch exceeds limits");
      const result = await this.client.analyzeBatch({ capabilities: ["face_visibility"], items: items.map(p => ({ id: String(p.index), timestampSeconds: p.timestampSeconds, image: p.image })) }, signal);
      const byId = new Map(result.items.map(p => [p.id, p]));
      for (const item of items) {
        const response = byId.get(String(item.index))!;
        const outcome = response.outcomes[0]!;
        const base = { index: item.index, timestamp: item.timestampSeconds };
        if (outcome.status === "error") {
          frames.push({ ...base, detected: null, max_confidence: null, error: outcome.error.code });
          continue;
        }
        if (response.width === undefined || response.height === undefined || outcome.findings.length !== 1) throw new Error("GPU visibility requires one explicit observation and dimensions per valid image");
        const finding = outcome.findings[0]!;
        if (finding.label !== "visibility" || finding.embedding !== undefined) throw new Error("Identity data is forbidden in visibility observations");
        const observation = observationSchema.parse(finding.metadata);
        if (finding.score !== observation.max_confidence) throw new Error("Visibility confidence receipt differs");
        const framePolicy = policySchema.parse(observation);
        if (policy && JSON.stringify(policy) !== JSON.stringify(framePolicy)) throw new Error("GPU face visibility policy changed within a generation");
        policy = framePolicy;
        frames.push({ ...base, detected: observation.detected, max_confidence: observation.max_confidence, policy: framePolicy });
      }
    }
    return { generationIdentity: input.generationIdentity, frames, policy };
  }
}
