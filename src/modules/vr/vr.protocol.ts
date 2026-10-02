import { createHmac, timingSafeEqual } from "node:crypto";
import type { Video } from "@/modules/videos/videos.types";

export interface VrLease {
  userId: number;
  expiresAt: number;
}
export function issueVrToken(
  userId: number,
  secret: string,
  now = Date.now()
): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, expiresAt: now + 30 * 86400000, scope: "vr-read" })
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyVrToken(
  token: string,
  secret: string,
  now = Date.now()
): VrLease | null {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    const lease = JSON.parse(Buffer.from(payload, "base64url").toString());
    return lease.scope === "vr-read" &&
      Number.isInteger(lease.userId) &&
      lease.userId > 0 &&
      Number.isFinite(lease.expiresAt) &&
      lease.expiresAt > now
      ? lease
      : null;
  } catch {
    return null;
  }
}
export interface VrProjection {
  screenType:
    | "flat"
    | "dome"
    | "sphere"
    | "fisheye"
    | "fisheye190"
    | "mkx220"
    | "mkx200"
    | "rf52"
    | "vrca220";
  stereoMode: "off" | "sbs" | "tb";
  fov: number;
  lens: "Linear" | "MKX200" | "MKX220" | "VRCA220";
}
/** Explicit metadata wins over bounded filename conventions. Lens flags precede generic 180/360 flags. */
export function projectionFor(
  video: Pick<Video, "file_name">,
  metadata: { key: string; value: string }[] = []
): VrProjection {
  const values = Object.fromEntries(
    metadata.map(({ key, value }) => [key, value.trim().toLowerCase()])
  );
  const file = video.file_name.toLowerCase();
  const flag = (value: string) =>
    new RegExp(`(?:^|[_. -])${value}(?:[_. -]|$)`).test(file);
  const named = [
    "rf52",
    "mkx200",
    "mkx220",
    "vrca220",
    "fisheye220",
    "fisheye200",
    "fisheye190",
    "fisheye180",
    "fisheye",
    "360",
    "180",
  ].find(flag);
  const explicit = values["vr.projection"];
  const known = [
    "flat",
    "dome",
    "sphere",
    "fisheye",
    "mkx200",
    "mkx220",
    "rf52",
    "vrca220",
    "fisheye190",
    "fisheye200",
    "fisheye220",
  ];
  const format = explicit && known.includes(explicit) ? explicit : named;
  const screenType: VrProjection["screenType"] =
    format === "rf52" ||
    format === "mkx200" ||
    format === "mkx220" ||
    format === "fisheye190" ||
    format === "vrca220"
      ? format
      : format?.startsWith("fisheye") || format === "mkx220"
        ? "fisheye"
        : format === "360" || format === "sphere"
          ? "sphere"
          : format === "180" || format === "dome"
            ? "dome"
            : "flat";
  const lensDefault =
    format === "mkx200"
      ? "MKX200"
      : format === "mkx220"
        ? "MKX220"
        : format === "vrca220"
          ? "VRCA220"
          : "Linear";
  const lensNames = {
    linear: "Linear",
    mkx200: "MKX200",
    mkx220: "MKX220",
    vrca220: "VRCA220",
  } as const;
  const lens =
    lensNames[values["vr.lens"] as keyof typeof lensNames] ?? lensDefault;
  const fovDefault =
    format === "rf52" || format === "fisheye190"
      ? 190
      : format === "mkx200" || format === "fisheye200"
        ? 200
        : format === "mkx220" || format === "vrca220" || format === "fisheye220"
          ? 220
          : screenType === "sphere"
            ? 360
            : screenType === "flat"
              ? 90
              : 180;
  const fovValue = Number(values["vr.fov"]);
  const fov =
    Number.isFinite(fovValue) && fovValue >= 30 && fovValue <= 360
      ? fovValue
      : fovDefault;
  const stereo = values["vr.stereo"];
  const stereoMode: VrProjection["stereoMode"] =
    stereo === "sbs" || stereo === "tb" || stereo === "off"
      ? stereo
      : ["sbs", "lr", "3dh"].some(flag)
        ? "sbs"
        : ["tb", "3dv", "overunder"].some(flag)
          ? "tb"
          : "off";
  return { screenType, stereoMode, fov, lens };
}
export function groupByCreator(videos: Video[]) {
  const groups = new Map<string, Video[]>();
  for (const video of videos) {
    for (const name of video.creators?.length
      ? video.creators.map((c) => c.name)
      : ["Sem criador identificado"]) {
      const group = groups.get(name) ?? [];
      group.push(video);
      groups.set(name, group);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}
export function deoVideo(
  video: Video,
  base: string,
  token: string,
  metadata: { key: string; value: string }[] = []
) {
  const projection = projectionFor(video, metadata);
  return {
    id: video.id,
    title: video.title || video.file_name,
    videoLength: video.duration_seconds || 0,
    thumbnailUrl: `${base}/thumbnail/${video.id}?token=${encodeURIComponent(token)}`,
    screenType: projection.screenType,
    stereoMode: projection.stereoMode,
    fov: projection.fov,
    is3d: projection.stereoMode !== "off",
    encodings: [
      {
        name: video.codec === "hevc" ? "h265" : video.codec || "h264",
        videoSources: [
          {
            resolution: video.height || 1080,
            url: `${base}/stream/${video.id}?token=${encodeURIComponent(token)}`,
          },
        ],
      },
    ],
  };
}
export function hereVideo(
  video: Video,
  base: string,
  token: string,
  metadata: { key: string; value: string }[] = []
) {
  const projection = projectionFor(video, metadata);
  return {
    access: 1,
    title: video.title || video.file_name,
    description: video.description || "",
    thumbnailImage: `${base}/thumbnail/${video.id}?token=${encodeURIComponent(token)}`,
    duration: Math.round((video.duration_seconds || 0) * 1000),
    dateAdded: video.created_at.slice(0, 10),
    isFavorite: video.is_favorite,
    projection: {
      flat: "perspective",
      dome: "equirectangular",
      sphere: "equirectangular360",
      fisheye: "fisheye",
      fisheye190: "fisheye",
      mkx220: "fisheye",
      mkx200: "fisheye",
      rf52: "fisheye",
      vrca220: "fisheye",
    }[projection.screenType],
    stereo: projection.stereoMode === "off" ? "mono" : projection.stereoMode,
    // XBVR uses equirectangular360 with FOV 180; 360 selects the mesh, not this lens field.
    fov: projection.screenType === "sphere" ? 180 : projection.fov,
    lens: projection.lens,
    tags: [
      ...(video.creators || []).map((c) => ({ name: `Talent:${c.name}` })),
      ...(video.tags || []).map((t) => ({ name: `Category:${t.name}` })),
    ],
    media: [
      {
        name: "Original",
        sources: [
          {
            resolution: String(video.height || 1080),
            width: video.width || 0,
            height: video.height || 0,
            size: video.file_size_bytes,
            url: `${base}/stream/${video.id}?token=${encodeURIComponent(token)}`,
          },
        ],
      },
    ],
    writeFavorite: false,
    writeRating: false,
    writeTags: false,
    writeHSP: false,
  };
}
