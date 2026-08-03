import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";
import { createReadStream } from "fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join, resolve } from "path";
import { env } from "@/config/env";
import { resolveDemoAssetPath } from "@/database/demo";
import { videosService } from "@/modules/videos/videos.service";
import { AppError, NotFoundError } from "@/utils/errors";
import { fileExists } from "@/utils/file-utils";
import { logger } from "@/utils/logger";
import type {
  CastEncodingMode,
  CastProfileConfig,
  CastSessionState,
  CastSessionStatus,
  CastTranscodeProfile,
} from "./cast.types";
import {
  calculateHlsBandwidth,
  getCastAssetKind,
  parseByteRange,
} from "./cast-hls.utils";

const SEGMENT_SECONDS = 4;
const PLAYLIST_POLL_INTERVAL_MS = 250;
const AUDIO_BITRATE_BITS_PER_SECOND = 192_000;
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_PATTERN =
  /^(?:master\.m3u8|index\.m3u8|init\.mp4|segment-\d{6}\.(?:m4s|ts))$/;

const PROFILE_CONFIGS: Record<CastTranscodeProfile, CastProfileConfig> = {
  "original-hevc": {
    id: "original-hevc",
    label: "Best quality (HEVC)",
    codec: "hevc",
    maxWidth: null,
    bitrate: "40M",
    maxrate: "60M",
    bufsize: "60M",
    qp: 20,
  },
  "1080p-hevc": {
    id: "1080p-hevc",
    label: "1080p (HEVC)",
    codec: "hevc",
    maxWidth: 1920,
    bitrate: "16M",
    maxrate: "24M",
    bufsize: "24M",
    qp: 22,
  },
  "720p-hevc": {
    id: "720p-hevc",
    label: "720p (HEVC)",
    codec: "hevc",
    maxWidth: 1280,
    bitrate: "8M",
    maxrate: "12M",
    bufsize: "12M",
    qp: 23,
  },
  "1080p-h264": {
    id: "1080p-h264",
    label: "1080p compatibility (H.264)",
    codec: "h264",
    maxWidth: 1920,
    bitrate: "8M",
    maxrate: "12M",
    bufsize: "12M",
    qp: 20,
  },
  "720p-h264": {
    id: "720p-h264",
    label: "720p compatibility (H.264)",
    codec: "h264",
    maxWidth: 1280,
    bitrate: "4M",
    maxrate: "6M",
    bufsize: "6M",
    qp: 21,
  },
};

interface CastSessionRecord {
  id: string;
  ownerUserId: number;
  videoId: number;
  profile: CastProfileConfig;
  sourcePath: string;
  outputDir: string;
  durationSeconds: number | null;
  requestedStartSeconds: number;
  state: CastSessionState;
  encodingMode: CastEncodingMode;
  attemptIndex: number;
  process: ChildProcessWithoutNullStreams | null;
  lastAccessAt: number;
  stopping: boolean;
  stderrTail: string;
  attemptGeneration: number;
  errorMessage?: string;
  requestKey?: string;
}

export interface CastMediaAsset {
  stream: ReturnType<typeof createReadStream>;
  statusCode: 200 | 206;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  assetKind: ReturnType<typeof getCastAssetKind>;
  cacheControl: string;
}

const ENCODING_ATTEMPTS: CastEncodingMode[] = [
  "hardware",
  "software-decode",
  "software",
];

export class CastTranscodingService {
  private sessions = new Map<string, CastSessionRecord>();
  private sessionIdsByRequestKey = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await mkdir(env.CAST_TRANSCODE_DIR, { recursive: true });
    await this.removeStaleDirectories();

    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleSessions();
    }, env.CAST_SESSION_CLEANUP_INTERVAL_SECONDS * 1000);
    this.cleanupTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await Promise.all(
      Array.from(this.sessions.keys()).map((id) => this.deleteSessionById(id))
    );
    this.started = false;
  }

  async createSession(options: {
    videoId: number;
    ownerUserId: number;
    profile: CastTranscodeProfile;
    requestedStartSeconds: number;
    requestKey?: string;
  }): Promise<CastSessionStatus> {
    await this.start();
    const dedupeKey = options.requestKey
      ? `${options.ownerUserId}:${options.videoId}:${options.profile}:${options.requestKey}`
      : null;
    if (dedupeKey) {
      const existingId = this.sessionIdsByRequestKey.get(dedupeKey);
      const existing = existingId ? this.sessions.get(existingId) : undefined;
      if (existing) {
        this.touch(existing);
        return this.buildStatus(existing);
      }
      this.sessionIdsByRequestKey.delete(dedupeKey);
    }
    const video = await videosService.findById(
      options.videoId,
      options.ownerUserId
    );
    const sourcePath = env.DEMO_MODE
      ? resolveDemoAssetPath(video.file_path, { mustExist: true })
      : video.file_path;

    if (!video.is_available || !fileExists(sourcePath)) {
      throw new AppError(410, "Video file is not available");
    }

    const id = randomBytes(32).toString("hex");
    const outputDir = join(resolve(env.CAST_TRANSCODE_DIR), id);
    await mkdir(outputDir, { recursive: true });

    const session: CastSessionRecord = {
      id,
      ownerUserId: options.ownerUserId,
      videoId: options.videoId,
      profile: PROFILE_CONFIGS[options.profile],
      sourcePath,
      outputDir,
      durationSeconds: video.duration_seconds,
      requestedStartSeconds: Math.max(0, options.requestedStartSeconds),
      state: "starting",
      encodingMode: "hardware",
      attemptIndex: 0,
      process: null,
      lastAccessAt: Date.now(),
      stopping: false,
      stderrTail: "",
      attemptGeneration: 0,
      ...(dedupeKey ? { requestKey: dedupeKey } : {}),
    };

    this.sessions.set(id, session);
    if (dedupeKey) this.sessionIdsByRequestKey.set(dedupeKey, id);
    this.launchAttempt(session);
    logger.info(
      {
        castSessionId: id,
        videoId: options.videoId,
        profile: options.profile,
        outputDir,
      },
      "Started Cast HLS session"
    );

    return this.getStatus(options.videoId, id, options.ownerUserId);
  }

  async getStatus(
    videoId: number,
    sessionId: string,
    ownerUserId: number
  ): Promise<CastSessionStatus> {
    const session = this.getOwnedSession(videoId, sessionId, ownerUserId);
    this.touch(session);
    return this.buildStatus(session);
  }

  async deleteSession(
    videoId: number,
    sessionId: string,
    ownerUserId: number
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.videoId !== videoId || session.ownerUserId !== ownerUserId) {
      throw new NotFoundError("Cast session not found or expired");
    }
    await this.deleteSessionById(sessionId);
  }

  async getMediaAsset(
    token: string,
    asset: string,
    rangeHeader?: string
  ): Promise<CastMediaAsset> {
    if (!SESSION_TOKEN_PATTERN.test(token) || !ASSET_PATTERN.test(asset)) {
      throw new NotFoundError("Cast media asset not found");
    }
    const session = this.sessions.get(token);
    if (!session) {
      throw new NotFoundError("Cast session not found or expired");
    }

    this.touch(session);
    const assetPath = join(session.outputDir, asset);
    let assetStat;
    try {
      assetStat = await stat(assetPath);
    } catch {
      throw new NotFoundError("Cast media asset is not ready");
    }

    const range = rangeHeader
      ? parseByteRange(rangeHeader, assetStat.size)
      : null;
    if (rangeHeader && !range) {
      throw new AppError(416, "Range Not Satisfiable");
    }
    const contentLength = range ? range.end - range.start + 1 : assetStat.size;

    return {
      stream: range
        ? createReadStream(assetPath, { start: range.start, end: range.end })
        : createReadStream(assetPath),
      statusCode: range ? 206 : 200,
      contentType: asset.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : asset.endsWith(".mp4")
          ? "video/mp4"
          : asset.endsWith(".ts")
            ? "video/mp2t"
            : "video/iso.segment",
      contentLength,
      ...(range
        ? {
            contentRange: `bytes ${range.start}-${range.end}/${assetStat.size}`,
          }
        : {}),
      assetKind: getCastAssetKind(asset),
      cacheControl: asset.endsWith(".m3u8")
        ? "no-store, no-cache, must-revalidate"
        : "private, max-age=600, immutable",
    };
  }

  private launchAttempt(session: CastSessionRecord): void {
    const encodingMode = ENCODING_ATTEMPTS[session.attemptIndex];
    if (!encodingMode) {
      session.state = "failed";
      session.errorMessage = "All Cast transcoding modes failed";
      return;
    }

    session.encodingMode = encodingMode;
    session.state = "starting";
    session.stderrTail = "";
    session.errorMessage = undefined;
    const attemptGeneration = ++session.attemptGeneration;

    const args = this.buildFfmpegArgs(session, encodingMode);
    const child = spawn(env.FFMPEG_PATH, args);
    session.process = child;
    logger.info(
      {
        castSessionId: session.id,
        videoId: session.videoId,
        encodingMode,
        codec: session.profile.codec,
        args,
      },
      "Launching Cast FFmpeg"
    );

    child.stderr.on("data", (chunk: Buffer) => {
      session.stderrTail = `${session.stderrTail}${chunk.toString()}`.slice(
        -16_384
      );
    });
    child.on("error", (error) => {
      session.stderrTail = `${session.stderrTail}\n${error.message}`.slice(
        -16_384
      );
    });
    child.on("close", (code, signal) => {
      session.process = null;
      if (session.stopping) return;
      if (code === 0) {
        void this.finalizeSession(session).then(
          () => {
            if (session.stopping) return;
            session.state = "completed";
            logger.info(
              {
                castSessionId: session.id,
                videoId: session.videoId,
                encodingMode: session.encodingMode,
              },
              "Completed Cast HLS transcode"
            );
          },
          (error: unknown) => {
            if (session.stopping) return;
            if (
              session.state !== "ready" &&
              session.attemptIndex + 1 < ENCODING_ATTEMPTS.length
            ) {
              session.attemptIndex += 1;
              session.stderrTail = `${session.stderrTail}\n${
                error instanceof Error ? error.message : String(error)
              }`.slice(-16_384);
              void this.clearOutputDirectory(session).then(() => {
                if (!session.stopping) this.launchAttempt(session);
              });
              return;
            }
            session.state = "failed";
            session.errorMessage =
              error instanceof Error
                ? `Could not finalize Cast HLS: ${error.message}`
                : "Could not finalize Cast HLS";
            logger.error(
              { error, castSessionId: session.id, videoId: session.videoId },
              "Failed to finalize Cast HLS session"
            );
          }
        );
        return;
      }

      logger.warn(
        {
          castSessionId: session.id,
          videoId: session.videoId,
          encodingMode: session.encodingMode,
          code,
          signal,
          ffmpeg: session.stderrTail,
        },
        "Cast FFmpeg attempt failed"
      );

      if (session.state === "ready") {
        session.state = "failed";
        session.errorMessage = this.formatFfmpegError(session.stderrTail);
        return;
      }

      session.attemptIndex += 1;
      if (session.attemptIndex >= ENCODING_ATTEMPTS.length) {
        session.state = "failed";
        session.errorMessage = this.formatFfmpegError(session.stderrTail);
        return;
      }

      void this.clearOutputDirectory(session).then(() => {
        if (!session.stopping) this.launchAttempt(session);
      });
    });

    void this.watchForPlayableManifest(session, attemptGeneration);
  }

  private buildFfmpegArgs(
    session: CastSessionRecord,
    encodingMode: CastEncodingMode
  ): string[] {
    const args = ["-hide_banner", "-nostdin", "-loglevel", "warning"];
    const usesVaapi = encodingMode !== "software";
    const hardwareDecode = encodingMode === "hardware";

    if (usesVaapi) {
      args.push("-init_hw_device", `vaapi=va:${env.VAAPI_DEVICE}`);
    }
    if (hardwareDecode) {
      args.push(
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        "va",
        "-hwaccel_output_format",
        "vaapi"
      );
    } else {
      args.push("-threads", "0");
    }

    args.push("-i", session.sourcePath, "-map", "0:v:0", "-map", "0:a:0?");
    if (usesVaapi) args.push("-filter_hw_device", "va");

    const maxWidth = session.profile.maxWidth;
    const hardwareScale =
      maxWidth === null
        ? null
        : `scale_vaapi=w=${maxWidth}:h=${maxWidth}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const softwareScale =
      maxWidth === null
        ? null
        : `scale=w=${maxWidth}:h=${maxWidth}:force_original_aspect_ratio=decrease:force_divisible_by=2`;

    if (hardwareDecode && hardwareScale) {
      args.push("-vf", hardwareScale);
    } else if (encodingMode === "software-decode") {
      args.push(
        "-vf",
        hardwareScale
          ? `format=nv12,hwupload,${hardwareScale}`
          : "format=nv12,hwupload"
      );
    } else if (encodingMode === "software") {
      args.push(
        "-vf",
        softwareScale ? `${softwareScale},format=yuv420p` : "format=yuv420p"
      );
    }

    const videoCodec =
      encodingMode === "software"
        ? session.profile.codec === "hevc"
          ? "libx265"
          : "libx264"
        : session.profile.codec === "hevc"
          ? "hevc_vaapi"
          : "h264_vaapi";
    args.push("-fps_mode:v", "passthrough", "-c:v", videoCodec);

    if (encodingMode === "software") {
      args.push(
        "-preset",
        "medium",
        "-crf",
        session.profile.qp.toString(),
        "-maxrate",
        session.profile.maxrate,
        "-bufsize",
        session.profile.bufsize
      );
    } else {
      args.push(
        "-async_depth",
        "64",
        "-rc_mode",
        "QVBR",
        "-b:v",
        session.profile.bitrate,
        "-maxrate",
        session.profile.maxrate,
        "-bufsize",
        session.profile.bufsize,
        "-global_quality:v",
        session.profile.qp.toString()
      );
    }

    if (session.profile.codec === "hevc") {
      // FFmpeg 8 + radeonsi emits corrupt fragmented MP4 when hevc_vaapi is
      // forcibly tagged hvc1. Its native hev1 sample entry is valid and is
      // advertised verbatim in the generated master playlist.
      args.push("-profile:v", "main");
    } else {
      args.push("-profile:v", "high", "-level:v", "4.1");
      if (usesVaapi) args.push("-aud", "1");
    }

    args.push(
      "-flags",
      "+cgop",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "192k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-f",
      "hls",
      "-hls_time",
      SEGMENT_SECONDS.toString(),
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "event",
      "-hls_flags",
      "independent_segments+temp_file"
    );

    if (session.profile.codec === "hevc") {
      args.push(
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        "init.mp4",
        "-hls_segment_filename",
        join(session.outputDir, "segment-%06d.m4s")
      );
    } else {
      args.push(
        "-mpegts_flags",
        "+resend_headers",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-hls_segment_type",
        "mpegts",
        "-hls_segment_filename",
        join(session.outputDir, "segment-%06d.ts")
      );
    }

    args.push("-y", join(session.outputDir, "index.m3u8"));
    return args;
  }

  private async buildStatus(
    session: CastSessionRecord
  ): Promise<CastSessionStatus> {
    const [sizeBytes, generatedDurationSeconds] = await Promise.all([
      this.getDirectorySize(session.outputDir),
      this.getGeneratedDuration(session.outputDir),
    ]);
    const duration = session.durationSeconds;
    const progressPercent =
      duration && duration > 0
        ? Math.min(100, Math.round((generatedDurationSeconds / duration) * 100))
        : null;

    return {
      id: session.id,
      video_id: session.videoId,
      profile: session.profile.id,
      profile_label: session.profile.label,
      video_codec: session.profile.codec,
      content_type: "application/x-mpegURL",
      manifest_url: `/api/cast/${session.id}/master.m3u8`,
      state: session.state,
      encoding_mode: session.encodingMode,
      size_bytes: sizeBytes,
      generated_duration_seconds: generatedDurationSeconds,
      duration_seconds: duration,
      progress_percent: progressPercent,
      expires_at: new Date(
        session.lastAccessAt + env.CAST_SESSION_IDLE_TTL_MINUTES * 60_000
      ).toISOString(),
      ...(session.errorMessage ? { error_message: session.errorMessage } : {}),
    };
  }

  private getOwnedSession(
    videoId: number,
    sessionId: string,
    ownerUserId: number
  ): CastSessionRecord {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.videoId !== videoId ||
      session.ownerUserId !== ownerUserId
    ) {
      throw new NotFoundError("Cast session not found or expired");
    }
    return session;
  }

  private touch(session: CastSessionRecord): void {
    session.lastAccessAt = Date.now();
  }

  private async cleanupIdleSessions(): Promise<void> {
    const cutoff = Date.now() - env.CAST_SESSION_IDLE_TTL_MINUTES * 60_000;
    const expired = Array.from(this.sessions.values())
      .filter((session) => session.lastAccessAt < cutoff)
      .map((session) => session.id);
    await Promise.all(expired.map((id) => this.deleteSessionById(id)));
  }

  private async deleteSessionById(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.requestKey)
      this.sessionIdsByRequestKey.delete(session.requestKey);
    session.stopping = true;

    if (session.process && !session.process.killed) {
      const processToKill = session.process;
      processToKill.kill("SIGTERM");
      setTimeout(() => {
        if (processToKill.exitCode === null) processToKill.kill("SIGKILL");
      }, 3_000).unref?.();
    }

    await rm(session.outputDir, { recursive: true, force: true });
    logger.info(
      { castSessionId: sessionId, videoId: session.videoId },
      "Deleted Cast HLS session"
    );
  }

  private async clearOutputDirectory(
    session: CastSessionRecord
  ): Promise<void> {
    await rm(session.outputDir, { recursive: true, force: true });
    await mkdir(session.outputDir, { recursive: true });
  }

  private async removeStaleDirectories(): Promise<void> {
    let entries;
    try {
      entries = await readdir(env.CAST_TRANSCODE_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && SESSION_TOKEN_PATTERN.test(entry.name)
        )
        .map((entry) =>
          rm(join(env.CAST_TRANSCODE_DIR, entry.name), {
            recursive: true,
            force: true,
          })
        )
    );
  }

  private async getDirectorySize(directory: string): Promise<number> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return 0;
    }
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return this.getDirectorySize(path);
        try {
          return (await stat(path)).size;
        } catch {
          return 0;
        }
      })
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private async getGeneratedDuration(directory: string): Promise<number> {
    try {
      const manifest = await readFile(join(directory, "index.m3u8"), "utf8");
      return Array.from(manifest.matchAll(/^#EXTINF:([\d.]+)/gm)).reduce(
        (sum, match) => sum + Number(match[1] ?? 0),
        0
      );
    } catch {
      return 0;
    }
  }

  private async watchForPlayableManifest(
    session: CastSessionRecord,
    attemptGeneration: number
  ): Promise<void> {
    while (
      !session.stopping &&
      session.attemptGeneration === attemptGeneration &&
      session.state === "starting"
    ) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, PLAYLIST_POLL_INTERVAL_MS)
      );

      let playlist: string;
      try {
        playlist = await readFile(
          join(session.outputDir, "index.m3u8"),
          "utf8"
        );
      } catch {
        continue;
      }

      const generatedDuration = this.getPlaylistDuration(playlist);
      const requiredDuration = session.durationSeconds
        ? Math.min(
            session.durationSeconds,
            session.requestedStartSeconds + env.CAST_HLS_STARTUP_BUFFER_SECONDS
          )
        : session.requestedStartSeconds + env.CAST_HLS_STARTUP_BUFFER_SECONDS;
      const segmentCount = Array.from(
        playlist.matchAll(/^segment-\d{6}\.(?:m4s|ts)$/gm)
      ).length;
      if (generatedDuration < requiredDuration || segmentCount < 2) continue;

      const validation = await this.validatePlaylistSnapshot(
        session,
        playlist,
        attemptGeneration
      );
      if (
        session.stopping ||
        session.attemptGeneration !== attemptGeneration ||
        session.state !== "starting"
      ) {
        return;
      }
      if (!validation.valid) {
        session.stderrTail = `${session.stderrTail}\n${validation.error}`.slice(
          -16_384
        );
        session.process?.kill("SIGTERM");
        return;
      }

      const [measuredBandwidth, videoMetadata] = await Promise.all([
        this.getHlsBandwidth(session, playlist),
        this.probePublishedVideo(session),
      ]);
      if (
        session.stopping ||
        session.attemptGeneration !== attemptGeneration ||
        session.state !== "starting"
      ) {
        return;
      }

      await this.writeMasterPlaylist(
        session,
        {
          average: Math.max(
            measuredBandwidth.average,
            this.getConfiguredAverageBandwidth(session)
          ),
          peak: Math.max(
            measuredBandwidth.peak,
            this.getConfiguredPeakBandwidth(session)
          ),
        },
        videoMetadata
      );
      session.state = "ready";
      logger.info(
        {
          castSessionId: session.id,
          videoId: session.videoId,
          generatedDuration,
          requestedStartSeconds: session.requestedStartSeconds,
          startupBufferSeconds: env.CAST_HLS_STARTUP_BUFFER_SECONDS,
          videoMetadata,
        },
        "Published progressive Cast HLS session"
      );
      return;
    }
  }

  private async finalizeSession(session: CastSessionRecord): Promise<void> {
    const playlistPath = join(session.outputDir, "index.m3u8");
    const eventPlaylist = await readFile(playlistPath, "utf8");
    if (!eventPlaylist.includes("#EXT-X-ENDLIST")) {
      throw new Error("media playlist is incomplete");
    }

    const validation = await this.validatePlaylistSnapshot(
      session,
      eventPlaylist,
      session.attemptGeneration
    );
    if (!validation.valid) {
      throw new Error(`media validation failed: ${validation.error}`);
    }

    const [bandwidth, videoMetadata] = await Promise.all([
      this.getHlsBandwidth(session, eventPlaylist),
      this.probeHlsVideo(playlistPath),
    ]);
    await this.writeMasterPlaylist(
      session,
      {
        average: bandwidth.average,
        peak: Math.max(
          bandwidth.peak,
          this.getConfiguredPeakBandwidth(session)
        ),
      },
      videoMetadata
    );

    logger.info(
      {
        castSessionId: session.id,
        videoId: session.videoId,
        averageBandwidth: bandwidth.average,
        peakBandwidth: bandwidth.peak,
        videoMetadata,
      },
      "Finalized Cast HLS manifest"
    );
  }

  private async writeMasterPlaylist(
    session: CastSessionRecord,
    bandwidth: { average: number; peak: number },
    videoMetadata: {
      width: number;
      height: number;
      frameRate: string | null;
      codecs: string;
    } | null
  ): Promise<void> {
    const streamAttributes = [
      `BANDWIDTH=${bandwidth.peak}`,
      `AVERAGE-BANDWIDTH=${bandwidth.average}`,
      ...(videoMetadata
        ? [
            `CODECS="${videoMetadata.codecs}"`,
            `RESOLUTION=${videoMetadata.width}x${videoMetadata.height}`,
            ...(videoMetadata.frameRate
              ? [`FRAME-RATE=${videoMetadata.frameRate}`]
              : []),
          ]
        : []),
    ].join(",");
    const masterPlaylist = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-STREAM-INF:${streamAttributes}`,
      "index.m3u8",
      "",
    ].join("\n");
    const masterTempPath = join(session.outputDir, "master.m3u8.finalizing");
    await writeFile(masterTempPath, masterPlaylist);
    await rename(masterTempPath, join(session.outputDir, "master.m3u8"));
  }

  private async getHlsBandwidth(
    session: CastSessionRecord,
    playlist: string
  ): Promise<{ average: number; peak: number }> {
    const assets = Array.from(
      playlist.matchAll(/^((?:segment-\d{6})\.(?:m4s|ts))$/gm),
      (match) => match[1]
    ).filter((asset): asset is string => Boolean(asset));
    const sizes = new Map<string, number>();
    await Promise.all(
      assets.map(async (asset) => {
        sizes.set(asset, (await stat(join(session.outputDir, asset))).size);
      })
    );
    return (
      calculateHlsBandwidth(playlist, sizes) ?? {
        average: this.getConfiguredAverageBandwidth(session),
        peak: this.getConfiguredPeakBandwidth(session),
      }
    );
  }

  private async probePublishedVideo(session: CastSessionRecord) {
    if (session.profile.codec === "hevc") {
      return this.probeHlsVideo(join(session.outputDir, "init.mp4"));
    }
    const entries = await readdir(session.outputDir);
    const firstSegment = entries
      .filter((entry) => /^segment-\d{6}\.ts$/.test(entry))
      .sort()[0];
    return firstSegment
      ? this.probeHlsVideo(join(session.outputDir, firstSegment))
      : null;
  }

  private async probeHlsVideo(playlistPath: string): Promise<{
    width: number;
    height: number;
    frameRate: string | null;
    codecs: string;
  } | null> {
    return new Promise((resolvePromise) => {
      const probe = spawn(env.FFPROBE_PATH, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,codec_tag_string,level,width,height,avg_frame_rate",
        "-of",
        "json",
        playlistPath,
      ]);
      let stdout = "";
      probe.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      probe.on("error", () => resolvePromise(null));
      probe.on("close", (code) => {
        if (code !== 0) {
          resolvePromise(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: Array<{
              codec_name?: string;
              codec_tag_string?: string;
              level?: number;
              width?: number;
              height?: number;
              avg_frame_rate?: string;
            }>;
          };
          const stream = parsed.streams?.[0];
          if (!stream?.width || !stream.height) {
            resolvePromise(null);
            return;
          }
          const [numerator = 0, denominator = 1] = (
            stream.avg_frame_rate ?? "0/1"
          )
            .split("/")
            .map(Number);
          const frameRate = denominator > 0 ? numerator / denominator : 0;
          const level =
            stream.level ?? (stream.codec_name === "h264" ? 41 : 153);
          const hevcTag = ["hev1", "hvc1"].includes(
            stream.codec_tag_string?.toLowerCase() ?? ""
          )
            ? stream.codec_tag_string!.toLowerCase()
            : "hev1";
          const codecs =
            stream.codec_name === "h264"
              ? `avc1.6400${level.toString(16).padStart(2, "0")},mp4a.40.2`
              : `${hevcTag}.1.6.L${level}.B0,mp4a.40.2`;
          resolvePromise({
            width: stream.width,
            height: stream.height,
            frameRate:
              frameRate > 0 ? frameRate.toFixed(3).replace(/\.?0+$/, "") : null,
            codecs,
          });
        } catch {
          resolvePromise(null);
        }
      });
    });
  }

  private async validatePlaylistSnapshot(
    session: CastSessionRecord,
    playlist: string,
    attemptGeneration: number
  ): Promise<{ valid: boolean; error: string }> {
    const validationPath = join(
      session.outputDir,
      `.validation-${attemptGeneration}.m3u8`
    );
    const snapshot = playlist.includes("#EXT-X-ENDLIST")
      ? playlist
      : `${playlist.trimEnd()}\n#EXT-X-ENDLIST\n`;
    await writeFile(validationPath, snapshot);

    try {
      return await new Promise((resolvePromise) => {
        const validator = spawn(env.FFMPEG_PATH, [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          validationPath,
          "-map",
          "0",
          "-f",
          "null",
          "-",
        ]);
        let stderr = "";
        validator.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
        });
        validator.on("error", (error) => {
          resolvePromise({ valid: false, error: error.message });
        });
        validator.on("close", (code) => {
          resolvePromise({
            valid: code === 0,
            error: stderr.trim() || `FFmpeg validation exited with ${code}`,
          });
        });
      });
    } finally {
      await rm(validationPath, { force: true });
    }
  }

  private getPlaylistDuration(playlist: string): number {
    return Array.from(playlist.matchAll(/^#EXTINF:([\d.]+)/gm)).reduce(
      (sum, match) => sum + Number(match[1] ?? 0),
      0
    );
  }

  private getConfiguredAverageBandwidth(session: CastSessionRecord): number {
    return Math.ceil(
      (this.parseBitrate(session.profile.bitrate) +
        AUDIO_BITRATE_BITS_PER_SECOND) *
        1.08
    );
  }

  private getConfiguredPeakBandwidth(session: CastSessionRecord): number {
    const muxMargin = session.profile.codec === "h264" ? 1.15 : 1.1;
    const videoCeiling =
      this.parseBitrate(session.profile.maxrate) +
      this.parseBitrate(session.profile.bufsize) / SEGMENT_SECONDS;
    return Math.ceil(
      (videoCeiling + AUDIO_BITRATE_BITS_PER_SECOND) * muxMargin
    );
  }

  private parseBitrate(value: string): number {
    const match = /^(\d+(?:\.\d+)?)([KMG])$/i.exec(value);
    if (!match) return 1_000_000;
    const amount = Number(match[1]);
    const unit = match[2]?.toUpperCase();
    const multiplier =
      unit === "G" ? 1_000_000_000 : unit === "M" ? 1_000_000 : 1_000;
    return Math.max(1, Math.round(amount * multiplier));
  }

  private formatFfmpegError(stderr: string): string {
    const line = stderr
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    return line
      ? `FFmpeg failed: ${line}`
      : "FFmpeg failed to create HLS media";
  }
}

export const castTranscodingService = new CastTranscodingService();
