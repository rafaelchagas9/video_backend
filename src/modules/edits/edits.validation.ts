import { ValidationError } from "@/utils/errors";
import { canonicalizeOutputFileName } from "./edits.output";
import type {
  CreateEditJobInput,
  EditAudioConfig,
  EditTimelineConfig,
  EditTransformConfig,
} from "./edits.types";

function validateTransform(
  transform: EditTransformConfig | undefined,
  context?: string
): void {
  const cropLabel = context ? `${context} crop` : "Crop";
  const rotationLabel = context ? `${context} rotation` : "Rotation";
  const crop = transform?.crop;
  if (crop) {
    const values = [crop.x, crop.y, crop.width, crop.height];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new ValidationError(`${cropLabel} values must be finite numbers`);
    }
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 1.000001 ||
      crop.y + crop.height > 1.000001
    ) {
      throw new ValidationError(
        `${cropLabel} must fit within normalized video bounds`
      );
    }
  }

  const rotate = transform?.rotate ?? 0;
  if (![0, 90, 180, 270].includes(rotate)) {
    throw new ValidationError(
      `${rotationLabel} must be 0, 90, 180, or 270 degrees`
    );
  }
}

function validateAudio(
  audio: EditAudioConfig | undefined,
  editedDuration: number,
  context: string,
  durationLabel = "edited duration"
): void {
  if (audio?.muted !== undefined && typeof audio.muted !== "boolean") {
    throw new ValidationError(`${context} muted must be a boolean`);
  }
  if (audio?.volume !== undefined) {
    if (
      !Number.isFinite(audio.volume) ||
      audio.volume < 0 ||
      audio.volume > 4
    ) {
      throw new ValidationError(`${context} volume must be between 0 and 4`);
    }
  }
  for (const [field, value] of [
    ["fade_in_seconds", audio?.fade_in_seconds],
    ["fade_out_seconds", audio?.fade_out_seconds],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || value > editedDuration)
    ) {
      throw new ValidationError(
        `${context} ${field} must fit within the ${durationLabel}`
      );
    }
  }
}

export function calculateExpectedDuration(
  timeline: EditTimelineConfig
): number {
  return timeline.segments.reduce(
    (total, segment) =>
      total + (segment.end - segment.start) / (segment.speed ?? 1),
    0
  );
}

export function validateEditRequest(
  input: CreateEditJobInput,
  sourceDuration: number | null
): void {
  if (input.output.format !== "mkv") {
    throw new ValidationError("Only MKV edit output is supported");
  }
  if (input.output.video_codec !== "av1") {
    throw new ValidationError("Only AV1 edit output is supported");
  }
  if (!(["opus", "aac"] as const).includes(input.output.audio_codec)) {
    throw new ValidationError("Audio codec must be opus or aac");
  }
  if (
    !Number.isInteger(input.output.directory_id) ||
    input.output.directory_id <= 0
  ) {
    throw new ValidationError("Output directory id must be a positive integer");
  }
  canonicalizeOutputFileName(input.output.file_name);

  if (input.timeline.segments.length === 0) {
    throw new ValidationError("Timeline must have at least one segment");
  }
  for (const [index, segment] of input.timeline.segments.entries()) {
    const speed = segment.speed ?? 1;
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    ) {
      throw new ValidationError(
        `Timeline segment ${index} must have an end after its start`
      );
    }
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) {
      throw new ValidationError(
        `Timeline segment ${index} speed must be between 0.1 and 10`
      );
    }
    if (sourceDuration !== null && segment.end > sourceDuration + 0.001) {
      throw new ValidationError(
        `Timeline segment ${index} exceeds the source duration`
      );
    }
    const editedSegmentDuration = (segment.end - segment.start) / speed;
    validateTransform(segment.transform, `Timeline segment ${index}`);
    validateAudio(
      segment.audio,
      editedSegmentDuration,
      `Timeline segment ${index} audio`,
      "edited segment duration"
    );
  }

  const expectedDuration = calculateExpectedDuration(input.timeline);
  validateTransform(input.timeline.transform);
  validateAudio(input.timeline.audio, expectedDuration, "Audio");
}
