export const DEFAULT_VISION_SERVICE_URL = "http://localhost:8100";

export interface VisionServiceEnvironmentSource {
  VISION_SERVICE_URL?: string;
  FACE_SERVICE_URL?: string;
  VISION_SERVICE_SECRET?: string;
  FACE_SERVICE_SECRET?: string;
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveVisionServiceEnvironment(
  source: VisionServiceEnvironmentSource
): { url: string; secret: string } {
  return {
    url:
      nonBlank(source.VISION_SERVICE_URL) ??
      nonBlank(source.FACE_SERVICE_URL) ??
      DEFAULT_VISION_SERVICE_URL,
    secret:
      nonBlank(source.VISION_SERVICE_SECRET) ??
      nonBlank(source.FACE_SERVICE_SECRET) ??
      "",
  };
}
