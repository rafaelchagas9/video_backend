/** Designer fixtures use the isolated demo catalogue and never run an inference model. */
import type { RecordingClip } from "@/database/schema";
import { demoRepository, getDemoDatabasePath } from "@/database/demo";
import type { LabelTask, LabelTaskKind } from "./recordings.label-tasks";

const generatedAt = "2026-10-10T12:00:00.000Z";
const answers = new Map<string, Pick<LabelTask, "answer" | "reasons" | "detail" | "answered_at">>();
const key = (id: number) => `${getDemoDatabasePath()}:${id}`;
type DemoVideo = { id: number; file_name: string; duration_seconds: number; creators?: { name: string }[] };
type Range = [number, number];
const range = (duration: number, from: number, to: number): Range => [Math.floor(duration * from), Math.floor(duration * to)];

function side(video: DemoVideo, clip: Range, best: Range) {
  const length = best[1] - best[0];
  const previewLength = Math.min(15, length);
  const starts = [best[0], best[0] + (length - previewLength) / 2, best[1] - previewLength];
  return {
    feedback_id: video.id, video_id: video.id, file_name: video.file_name,
    channel: video.creators?.[0]?.name ?? `Demo performer ${video.id}`,
    duration_seconds: video.duration_seconds, score: 0.84,
    clip, original_range: clip, best,
    snippet: [starts[1], starts[1]! + previewLength],
    previews: starts.map((start) => [start, start + previewLength]),
  };
}

export function demoLabelTasks(): LabelTask[] {
  const videos = demoRepository.getVideos({ limit: 4, minDuration: 60, sort: "file_name", order: "asc" }).data as DemoVideo[];
  const kinds: LabelTaskKind[] = ["recall-audit", "version-versus", "whole-verdict", "versus"];
  return kinds.flatMap((kind, kindIndex) => videos.map((video, index): LabelTask => {
    const duration = video.duration_seconds;
    const channel = video.creators?.[0]?.name ?? `Demo performer ${video.id}`;
    const original: Range = [0, duration];
    const a = side(video, original, range(duration, 0.1, 0.4));
    const other = index % 2 === 0 ? video : videos[(index + 1) % videos.length]!;
    const b = side(kind === "version-versus" ? video : other, kind === "version-versus" ? original : [0, other.duration_seconds], range(kind === "version-versus" ? duration : other.duration_seconds, 0.5, 0.8));
    let window: Range = range(duration, 0.4, 0.5);
    let context: Record<string, unknown> = { original_range: window };
    if (kind === "versus" || kind === "version-versus") {
      window = original;
      context = { a, b, ...(kind === "version-versus" ? { blind_version_comparison: true, target_semantics: "preferred_version_if_keep_one" } : { comparison_scope: other.id !== video.id ? "cross_channel" : "within_channel" }) };
    } else if (kind === "whole-verdict") {
      window = original;
      context = {
        target: "current_whole_recording_review", reserved_fine_holdout: false, fine_data_role: "training",
        original_range: original,
        candidate: {
          video_id: video.id, analyzed_at: generatedAt, duration_seconds: duration, channel, channel_key: channel.replace(/^@/, "").toLowerCase(),
          index: { model_revision: "siglip2/so400m-patch16-256", frame_count: Math.min(8000, Math.ceil(duration / 5)), interval_seconds: 5, storyboard_generated_at: generatedAt, indexed_at: generatedAt },
          source_fingerprint: { size_bytes: 0, mtime_ns: "0", path_identity_sha256: "0".repeat(64) },
        },
      };
    }
    const id = 800_000_000 + video.id * 10 + kindIndex;
    const answered = index === videos.length - 1 && videos.length > 1;
    const answer = answered ? ({ "recall-audit": "keep", "version-versus": "both", "whole-verdict": "edited_parts_only", versus: "b", refine: null } as const)[kind] : null;
    const task: LabelTask = {
      id, kind, batch: `demo-${kind}`, stratum: kind === "recall-audit" ? "near-miss" : "demo",
      position: index + 1, video_id: video.id, file_name: video.file_name, duration_seconds: duration,
      start_seconds: window[0], end_seconds: window[1], channel, context,
      answer, reasons: answer === "keep" ? ["audit_sound"] : [],
      detail: answer === "b" ? { best: { b: { start_seconds: b.best[0], end_seconds: b.best[1], accepted: true } } } : null,
      answered_at: answered ? generatedAt : null,
    };
    return structuredClone({ ...task, ...answers.get(key(id)) });
  }));
}

export function saveDemoLabelAnswer(task: LabelTask, answer: string | null, reasons: string[], detail: Record<string, unknown> | null): LabelTask {
  const next = { answer, reasons: answer === null ? [] : reasons, detail: answer === null ? null : detail, answered_at: answer === null ? null : new Date().toISOString() };
  answers.set(key(task.id), structuredClone(next));
  return structuredClone({ ...task, ...next });
}

export function demoHighlightAnalysis(duration: number): { clips: RecordingClip[]; curve: number[] } {
  const clips = [[0.08, 0.25], [0.34, 0.61], [0.7, 0.94]].map(([from, to], index): RecordingClip => {
    const [start, end] = range(duration, from!, to!);
    return { id: `c${index + 1}`, start_seconds: start, end_seconds: end, peak_seconds: (start + end) / 2,
      score: [0.91, 0.78, 0.86][index]!, label: ["Opening performance", "Main performance", "Closing performance"][index]!,
      keep: index !== 1, reasons: [], detected: { start_seconds: start, end_seconds: end } };
  }).filter((clip) => clip.end_seconds > clip.start_seconds);
  const curve = Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, i) => {
    const clip = clips.find((clip) => i * 5 >= clip.start_seconds && i * 5 <= clip.end_seconds);
    return clip ? clip.score - 0.08 * Math.abs(Math.sin(i * 0.6)) : 0.12;
  });
  return { clips, curve };
}
