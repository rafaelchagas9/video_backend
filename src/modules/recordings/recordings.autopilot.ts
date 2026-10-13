/**
 * The recorder autopilot. Each channel has a capture mode (recordings.sessions.policy.ts):
 * manual channels are left alone; whole and highlights channels are kept recording whenever they
 * are live; training channels get the data-gathering rules: every minute their live frame is read
 * with the trained highlight probe, recording starts when there is action, stops after a stretch
 * without it, and channels whose history says they add nothing more are retired. The
 * classifier's data targets are reported, not acted on. Decisions live in
 * recordings.autopilot.policy.ts. Every minute, whatever the mode, each live is also followed
 * (viewers, titles) and highlights lives are cut once they end (recordings.sessions.ts).
 *
 * GoondVR is driven only through its API (pause/resume/update), so nothing here depends on its
 * internals. In "suggest" mode every decision is logged but none is applied.
 */
import { desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recorderAutopilotChannelsTable, recorderAutopilotEventsTable, recorderAutopilotOutcomesTable } from "@/database/schema";
import { settingsService } from "@/modules/settings/settings.service";
import { visualSearchClient } from "@/modules/visual-search/visual-search.client";
import { halvesToFloats } from "@/modules/visual-search/visual-search.vectors";
import { logger } from "@/utils/logger";
import {
  AUTOPILOT_MODES,
  DEFAULT_AUTOPILOT_SETTINGS,
  actionScore,
  channelHistory,
  liveTransition,
  settledState,
  targetReached,
  type AutopilotSettings,
  type AutopilotState,
  type ChannelHistory,
  type Outcome,
  type Progress,
} from "./recordings.autopilot.policy";
import { GOONDVR_DEFAULT_PATTERN, goondvr, usernameFromFileName, type GoondvrChannel } from "./recordings.goondvr";
import { classifyFrames, loadHighlightProbe, probeThreshold } from "./recordings.probe";
import { recordingScope } from "./recordings.scope";
import { confirmedDecisions } from "./recordings.feedback";
import { liveSessions, type ChannelCapture } from "./recordings.sessions";
import { isCaptureMode, type CaptureMode } from "./recordings.sessions.policy";

const SETTINGS_KEY = "recordings_autopilot";
const CYCLE_MS = 60_000;
/**
 * Sites whose live frame GoondVR can serve. Streamlink sites (Twitch, Kick, YouTube) have none,
 * so the autopilot leaves them to the user.
 */
const READABLE_SITES = new Set(["chaturbate", "stripchat"]);
/** The storyboard tile the probe was trained on: SigLIP squashes it to 256×256 anyway. */
const TILE = { width: 456, height: 256 };

type ChannelRow = typeof recorderAutopilotChannelsTable.$inferSelect;

function parseSettings(raw: unknown): AutopilotSettings {
  let stored: Partial<AutopilotSettings> = {};
  try {
    stored = typeof raw === "string" && raw.trim() ? (JSON.parse(raw) as Partial<AutopilotSettings>) : {};
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_AUTOPILOT_SETTINGS, ...stored, targets: { ...DEFAULT_AUTOPILOT_SETTINGS.targets, ...stored.targets } };
  if (!(AUTOPILOT_MODES as readonly string[]).includes(merged.mode)) merged.mode = DEFAULT_AUTOPILOT_SETTINGS.mode;
  if (!isCaptureMode(merged.defaultCapture)) merged.defaultCapture = DEFAULT_AUTOPILOT_SETTINGS.defaultCapture;
  return merged;
}

const usernameKey = (username: string) => username.replace(/^@/, "").toLowerCase();

/** GoondVR pauses a channel itself for its limits; this one only means it was added paused. */
const NOT_A_LIMIT = "Added without auto-start";

/** The capture a channel has, or the default for one Kura has not stored yet. */
const captureOf = (row: ChannelRow | undefined, settings: AutopilotSettings): CaptureMode =>
  row && isCaptureMode(row.capture) ? row.capture : settings.defaultCapture;

class RecorderAutopilot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  lastCycleAt: Date | null = null;
  lastError: string | null = null;

  start() {
    if (this.timer || env.DEMO_MODE) return;
    this.timer = setInterval(() => void this.cycle(), CYCLE_MS);
    setTimeout(() => void this.cycle(), 5_000);
    logger.info("Recorder autopilot started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async settings(): Promise<AutopilotSettings> {
    return parseSettings(await settingsService.getValue(SETTINGS_KEY));
  }

  async updateSettings(update: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
    const current = await this.settings();
    const next = parseSettings(JSON.stringify({ ...current, ...update, targets: { ...current.targets, ...update.targets } }));
    await settingsService.updateValues({ [SETTINGS_KEY]: JSON.stringify(next) });
    if (update.mode && update.mode !== current.mode) await this.log(null, "mode", `mode: ${update.mode}`, true);
    return next;
  }

  /** `managed: false` is manual, `managed: true` the default capture (the older client's toggle). */
  async setManaged(channelId: string, managed: boolean) {
    const settings = await this.settings();
    const result = await this.setChannel(channelId, { capture: managed ? (settings.defaultCapture === "manual" ? "training" : settings.defaultCapture) : "manual" });
    return { channel_id: channelId, managed: result.capture !== "manual" };
  }

  /** A channel's capture mode and highlights threshold (null: the default). */
  async setChannel(channelId: string, update: { capture?: CaptureMode; threshold?: number | null }) {
    if (env.DEMO_MODE) return { channel_id: channelId, capture: update.capture ?? "manual", threshold: update.threshold ?? null };
    const settings = await this.settings();
    const [current] = await db.select().from(recorderAutopilotChannelsTable).where(eq(recorderAutopilotChannelsTable.channelId, channelId));
    const capture = update.capture ?? captureOf(current, settings);
    const threshold = update.threshold === undefined ? current?.highlightThreshold ?? null : update.threshold === null ? null : Math.min(0.99, Math.max(0.05, update.threshold));
    const set = { capture, managed: capture !== "manual", highlightThreshold: threshold, updatedAt: new Date() };
    await db
      .insert(recorderAutopilotChannelsTable)
      .values({ channelId, ...set })
      .onConflictDoUpdate({ target: recorderAutopilotChannelsTable.channelId, set });
    if (update.capture && update.capture !== captureOf(current, settings)) {
      await this.log(channelId, "managed", `${CAPTURE_TEXT[capture]}${capture === "highlights" && threshold !== null ? ` at ${Math.round(threshold * 100)}%` : ""}`, true);
      // Whole and highlights channels start recording now rather than on the next tick.
      if ((capture === "whole" || capture === "highlights") && settings.mode === "auto") {
        const channel = (await goondvr.channels())?.find((entry) => entry.id === channelId);
        if (channel?.is_paused && (!channel.pause_reason || channel.pause_reason === NOT_A_LIMIT)) {
          await goondvr.resumeChannel(channelId);
          await db
            .update(recorderAutopilotChannelsTable)
            .set({ state: "recording", reason: "kept recording", stateSince: new Date() })
            .where(eq(recorderAutopilotChannelsTable.channelId, channelId));
        }
      }
    }
    return { channel_id: channelId, capture, threshold };
  }

  /** One pass; overlapping ticks are skipped rather than queued. */
  async cycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings = await this.settings();
      const channels = await goondvr.channels();
      if (!channels) {
        this.lastError = "GoondVR is not reachable";
        return;
      }
      const now = new Date();
      const initial = await this.rows();
      await this.followLives(channels, initial, settings, now);
      if (settings.mode === "off") {
        this.lastCycleAt = now;
        this.lastError = null;
        return;
      }
      await this.syncOutcomes();
      const [queue, outcomes, rows] = await Promise.all([this.queue(), this.outcomes(), this.rows()]);
      const blocked = queue >= settings.queueLimit ? `${queue} recordings waiting for review` : null;
      const readings = await this.read(channels.filter((channel) => {
        const row = rows.get(channel.id);
        return channel.is_online && READABLE_SITES.has(channel.site) && captureOf(row, settings) === "training" && (!row || row.state === "watching" || row.state === "recording");
      }));
      for (const channel of channels) {
        await this.decide(channel, rows.get(channel.id), outcomes.get(usernameKey(channel.username)) ?? [], readings.get(channel.id), {
          settings,
          blocked,
          now,
        });
      }
      this.lastCycleAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error }, "Recorder autopilot cycle failed");
    } finally {
      this.running = false;
    }
  }

  /** Lives are followed and highlights cut whatever the autopilot's mode; one failure never stops the cycle. */
  private async followLives(channels: GoondvrChannel[], rows: Map<string, ChannelRow>, settings: AutopilotSettings, now: Date) {
    const capture = (channelId: string): ChannelCapture => {
      const row = rows.get(channelId);
      return { capture: captureOf(row, settings), threshold: row?.highlightThreshold ?? null };
    };
    try {
      await liveSessions.track(channels, capture, now);
      await liveSessions.advance(now);
    } catch (error) {
      logger.warn({ err: error }, "Following lives failed");
    }
  }

  private async decide(
    channel: GoondvrChannel,
    row: ChannelRow | undefined,
    outcomes: Outcome[],
    reading: number[] | undefined,
    context: { settings: AutopilotSettings; blocked: string | null; now: Date }
  ) {
    const { settings, now } = context;
    const apply = settings.mode === "auto";
    const current: ChannelRow =
      row ??
      (
        await db
          .insert(recorderAutopilotChannelsTable)
          .values({
            channelId: channel.id,
            state: "watching",
            reason: "new to the autopilot",
            capture: settings.defaultCapture,
            managed: settings.defaultCapture !== "manual",
          })
          .onConflictDoNothing()
          .returning()
      )[0] ??
      (await db.select().from(recorderAutopilotChannelsTable).where(eq(recorderAutopilotChannelsTable.channelId, channel.id)))[0]!;
    const capture = captureOf(current, settings);
    if (capture === "manual") return;
    if (capture === "whole" || capture === "highlights") return this.keepRecording(channel, current, settings, now);
    if (!READABLE_SITES.has(channel.site)) return;

    const patch: Partial<ChannelRow> = {};
    if (reading) {
      const hot = actionScore(reading) >= settings.startThreshold;
      patch.lastReading = reading;
      patch.lastReadingAt = now;
      patch.readings = current.readings + 1;
      patch.hotReadings = current.hotReadings + (hot ? 1 : 0);
      patch.hotStreak = hot ? current.hotStreak + 1 : 0;
      if (hot) patch.lastHotAt = now;
    } else if (!channel.is_online) {
      patch.hotStreak = 0;
    }
    const hotStreak = patch.hotStreak ?? current.hotStreak;
    const lastHotAt = patch.lastHotAt ?? current.lastHotAt;

    let state = current.state as AutopilotState;
    let reason = current.reason ?? "";
    const history = channelHistory(outcomes);
    const settled = settledState(history, settings);
    const recordingNow = !channel.is_paused;

    if (settled) {
      if (state !== settled.state) {
        state = settled.state;
        reason = settled.reason;
        await this.log(channel.id, "state", `${channel.username}: ${reason}`, apply);
      }
    } else {
      if (state === "enough" || state === "dropped" || state === "target") {
        state = "watching";
        reason = "watching again";
      }
      // A channel someone resumed by hand is treated as a recording the autopilot started.
      if (apply && state === "watching" && recordingNow && channel.is_online) {
        state = "recording";
        reason = "was already recording";
        patch.lastHotAt = now;
      }
      if (apply && state === "recording" && channel.is_paused && current.state === "recording") {
        if (!channel.pause_reason) {
          // Paused by hand while the autopilot was recording: the user takes the channel over.
          await db
            .update(recorderAutopilotChannelsTable)
            .set({ managed: false, capture: "manual", state: "watching", reason: "paused by hand", stateSince: now, updatedAt: now })
            .where(eq(recorderAutopilotChannelsTable.channelId, channel.id));
          await this.log(channel.id, "managed", `${channel.username}: paused by hand, now managed by hand`, true);
          return;
        }
        // GoondVR paused it itself (quota, disk): back to watching.
        state = "watching";
        reason = `GoondVR paused it: ${channel.pause_reason}`;
      }
      // A channel held by one of its own limits cannot record until the limit clears.
      const limited = channel.is_paused && channel.pause_reason && channel.pause_reason !== NOT_A_LIMIT ? `GoondVR limit: ${channel.pause_reason}` : null;
      const next = liveTransition(
        {
          state,
          stateSince: state === current.state ? current.stateSince : now,
          online: channel.is_online,
          hotStreak,
          lastHotAt: patch.lastHotAt ?? lastHotAt,
          title: channel.room_title ?? "",
          blocked: context.blocked ?? limited,
          now,
        },
        settings
      );
      if (next) {
        state = next.state;
        reason = next.reason;
        await this.log(channel.id, next.state === "recording" ? "start" : "stop", `${channel.username}: ${reason}`, apply);
      }
    }

    if (apply) {
      const want = state === "recording";
      if (want && channel.is_paused) {
        try {
          await this.ensureLimit(channel, settings);
          await goondvr.resumeChannel(channel.id);
        } catch (error) {
          state = "watching";
          reason = `GoondVR refused: ${error instanceof Error ? error.message : String(error)}`;
          await this.log(channel.id, "start", `${channel.username}: ${reason}`, false);
        }
      } else if (!want && !channel.is_paused) {
        await goondvr.pauseChannel(channel.id).catch((error) => logger.warn({ err: error, channel: channel.id }, "Autopilot could not pause"));
      } else if (!want && channel.is_paused) {
        await this.ensureLimit(channel, settings).catch(() => undefined);
      }
    }

    if (state !== current.state) {
      patch.state = state;
      patch.stateSince = now;
    }
    if (reason !== current.reason) patch.reason = reason;
    if (Object.keys(patch).length) {
      await db.update(recorderAutopilotChannelsTable).set({ ...patch, updatedAt: now }).where(eq(recorderAutopilotChannelsTable.channelId, channel.id));
    }
  }

  /**
   * Whole and highlights channels: recording whenever GoondVR can. A pause by hand while Kura had
   * it recording hands the channel over (manual); GoondVR's own limits are waited out.
   */
  private async keepRecording(channel: GoondvrChannel, current: ChannelRow, settings: AutopilotSettings, now: Date) {
    const apply = settings.mode === "auto";
    let state: AutopilotState = current.state as AutopilotState;
    let reason = current.reason ?? "";
    if (!channel.is_paused) {
      state = "recording";
      reason = channel.is_online ? "recording the whole live" : "waiting for a live";
    } else if (channel.pause_reason && channel.pause_reason !== NOT_A_LIMIT) {
      state = "watching";
      reason = `GoondVR limit: ${channel.pause_reason}`;
    } else if (current.state === "recording" && !channel.pause_reason) {
      await db
        .update(recorderAutopilotChannelsTable)
        .set({ managed: false, capture: "manual", state: "watching", reason: "paused by hand", stateSince: now, updatedAt: now })
        .where(eq(recorderAutopilotChannelsTable.channelId, channel.id));
      await this.log(channel.id, "managed", `${channel.username}: paused by hand, now managed by hand`, true);
      return;
    } else if (!apply) {
      state = "watching";
      reason = "would resume it (suggest mode)";
      if (reason !== current.reason) await this.log(channel.id, "start", `${channel.username}: ${reason}`, false);
    } else {
      try {
        await goondvr.resumeChannel(channel.id);
        state = "recording";
        reason = "kept recording";
        await this.log(channel.id, "start", `${channel.username}: ${CAPTURE_TEXT[captureOf(current, settings)].toLowerCase()}, resumed`, true);
      } catch (error) {
        state = "watching";
        reason = `GoondVR refused: ${error instanceof Error ? error.message : String(error)}`;
        if (reason !== current.reason) await this.log(channel.id, "start", `${channel.username}: ${reason}`, false);
      }
    }
    if (state === current.state && reason === current.reason) return;
    await db
      .update(recorderAutopilotChannelsTable)
      .set({ state, reason, ...(state !== current.state ? { stateSince: now } : {}), updatedAt: now })
      .where(eq(recorderAutopilotChannelsTable.channelId, channel.id));
  }

  /** Gives an unlimited channel the default stored-size limit; only while paused, since saving restarts it. */
  private async ensureLimit(channel: GoondvrChannel, settings: AutopilotSettings) {
    if (!settings.defaultKeepMb || channel.max_stored_size_mb > 0 || !channel.is_paused) return;
    await goondvr.updateChannel(channel.id, {
      username: channel.username,
      site: channel.site,
      framerate: channel.framerate,
      resolution: channel.resolution,
      pattern: channel.pattern || GOONDVR_DEFAULT_PATTERN,
      max_duration: channel.max_duration_minutes,
      max_filesize: channel.max_file_size_mb,
      max_stored_duration: channel.max_stored_duration_minutes,
      max_stored_size_mb: settings.defaultKeepMb,
    });
    channel.max_stored_size_mb = settings.defaultKeepMb;
    await this.log(channel.id, "limits", `${channel.username}: storage limit set to ${Math.round(settings.defaultKeepMb / 1024)} GB`, true);
  }

  /** Live-frame state probabilities per channel id; channels whose frame could not be read are absent. */
  private async read(channels: GoondvrChannel[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (!channels.length) return result;
    const probe = await loadHighlightProbe();
    if (!probe) return result;
    const images = new Map<string, Uint8Array>();
    const queue = [...channels];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let channel = queue.shift(); channel; channel = queue.shift()) {
          const response = await goondvr.thumbnail(channel.id, "live");
          if (!response) continue;
          try {
            const tile = await sharp(Buffer.from(await response.arrayBuffer()))
              .resize(TILE.width, TILE.height, { fit: "cover" })
              .jpeg({ quality: 85 })
              .toBuffer();
            images.set(channel.id, new Uint8Array(tile));
          } catch {
            // A placeholder or broken image is skipped this round.
          }
        }
      })
    );
    if (!images.size) return result;
    const pages = [...images].map(([id, image]) => ({ id, image, fileName: "live.jpg", tileWidth: TILE.width, tileHeight: TILE.height, columns: 1, count: 1 }));
    const embedded = await visualSearchClient.embedPages(pages, AbortSignal.timeout(120_000));
    if (embedded.modelRevision !== probe.modelRevision) {
      this.lastError = `the image model (${embedded.modelRevision}) is not the probe's (${probe.modelRevision})`;
      return result;
    }
    for (const [id, halves] of embedded.pages) {
      const vector = halvesToFloats(halves);
      const [probabilities] = classifyFrames(probe, [vector]);
      if (probabilities) result.set(id, Array.from(probabilities, (value) => Math.round(value * 1000) / 1000));
    }
    return result;
  }

  /** Records what every analysed recording yielded, so history outlives the files. */
  private async syncOutcomes() {
    const rows = await db.execute<{ video_id: number; file_name: string; status: string; clips: number; kept: number; skipped: number }>(sql`
      SELECT r.video_id, v.file_name, r.status, jsonb_array_length(r.clips)::int AS clips,
        (SELECT count(*) FROM ${confirmedDecisions} f WHERE f.video_id = r.video_id AND f.verdict = 'keep')::int AS kept,
        (SELECT count(*) FROM ${confirmedDecisions} f WHERE f.video_id = r.video_id AND f.verdict = 'skip')::int AS skipped
      FROM recording_reviews r JOIN videos v ON v.id = r.video_id`);
    for (const row of rows) {
      const channel = usernameFromFileName(String(row.file_name));
      if (!channel) continue;
      const stamp = /_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(String(row.file_name));
      const recordedAt = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : null;
      const values = {
        videoId: Number(row.video_id),
        channel,
        fileName: String(row.file_name),
        status: String(row.status),
        clips: Number(row.clips),
        kept: Number(row.kept),
        skipped: Number(row.skipped),
        recordedAt,
      };
      await db
        .insert(recorderAutopilotOutcomesTable)
        .values(values)
        .onConflictDoUpdate({
          target: recorderAutopilotOutcomesTable.videoId,
          set: { status: values.status, clips: values.clips, kept: values.kept, skipped: values.skipped, updatedAt: new Date() },
        });
    }
  }

  private async outcomes(): Promise<Map<string, Outcome[]>> {
    const rows = await db.select().from(recorderAutopilotOutcomesTable);
    const byChannel = new Map<string, Outcome[]>();
    for (const row of rows) {
      const key = usernameKey(row.channel);
      const list = byChannel.get(key) ?? [];
      list.push({ status: row.status, clips: row.clips, kept: row.kept, skipped: row.skipped, recordedAt: row.recordedAt });
      byChannel.set(key, list);
    }
    return byChannel;
  }

  async progress(): Promise<Progress> {
    const [row] = await db.execute<{ paired: number; channels: number; keeps: number }>(sql`
      SELECT
        (SELECT count(*) FROM (SELECT f.video_id FROM ${confirmedDecisions} f GROUP BY f.video_id
          HAVING bool_or(f.verdict = 'keep') AND bool_or(f.verdict = 'skip')) t)::int AS paired,
        (SELECT count(DISTINCT lower(regexp_replace(f.channel, '^@', ''))) FROM ${confirmedDecisions} f WHERE f.verdict = 'keep')::int AS channels,
        (SELECT count(*) FROM ${confirmedDecisions} f WHERE f.verdict = 'keep')::int AS keeps`);
    return { pairedRecordings: Number(row?.paired ?? 0), channels: Number(row?.channels ?? 0), keeps: Number(row?.keeps ?? 0) };
  }

  /** Recordings waiting for the user: proposed reviews plus recordings not analysed yet. */
  async queue(): Promise<number> {
    const scope = await recordingScope();
    const [row] = await db.execute<{ waiting: number }>(sql`
      SELECT (
        (SELECT count(*) FROM recording_reviews WHERE status = 'proposed') +
        (SELECT count(*) FROM videos v WHERE v.directory_id = ${scope.directoryId ?? -1}
          AND NOT EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id = v.id)
          AND v.file_name ~ '_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}')
      )::int AS waiting`);
    return Number(row?.waiting ?? 0);
  }

  private async rows(): Promise<Map<string, ChannelRow>> {
    const rows = await db.select().from(recorderAutopilotChannelsTable);
    return new Map(rows.map((row) => [row.channelId, row]));
  }

  private async log(channelId: string | null, action: string, reason: string, applied: boolean) {
    if (env.DEMO_MODE) return;
    await db.insert(recorderAutopilotEventsTable).values({ channelId, action, reason, applied });
  }

  /** Everything the Kura panel shows. */
  async status() {
    if (env.DEMO_MODE) {
      return { available: false, settings: DEFAULT_AUTOPILOT_SETTINGS, default_threshold: probeThreshold(1.4), progress: null, queue: 0, reached: false, channels: [], events: [], last_cycle_at: null, last_error: null };
    }
    const { recordingsService } = await import("./recordings.service");
    const [settings, progress, queue, rows, outcomes, events, recording] = await Promise.all([
      this.settings(),
      this.progress(),
      this.queue(),
      db.select().from(recorderAutopilotChannelsTable),
      this.outcomes(),
      db.select().from(recorderAutopilotEventsTable).orderBy(desc(recorderAutopilotEventsTable.id)).limit(80),
      recordingsService.settings(),
    ]);
    const historyOf = (channelId: string): ChannelHistory => channelHistory(outcomes.get(usernameKey(channelId.split("__").slice(1).join("__"))) ?? []);
    return {
      available: true,
      settings,
      default_threshold: probeThreshold(recording.sensitivity),
      progress,
      queue,
      reached: targetReached(progress, settings.targets),
      channels: rows.map((row) => ({
        channel_id: row.channelId,
        managed: captureOf(row, settings) !== "manual",
        capture: captureOf(row, settings),
        threshold: row.highlightThreshold,
        state: row.state,
        reason: row.reason,
        state_since: row.stateSince,
        action: row.lastReading ? actionScore(row.lastReading) : null,
        last_reading_at: row.lastReadingAt,
        readings: row.readings,
        hot_readings: row.hotReadings,
        history: historyOf(row.channelId),
      })),
      events: events.map((event) => ({ id: event.id, channel_id: event.channelId, action: event.action, reason: event.reason, applied: event.applied, at: event.createdAt })),
      last_cycle_at: this.lastCycleAt,
      last_error: this.lastError,
    };
  }
}

const CAPTURE_TEXT: Record<CaptureMode, string> = {
  manual: "Managed by hand",
  whole: "Recording whole lives",
  highlights: "Keeping highlights only",
  training: "Gathering training data",
};

export const recorderAutopilot = new RecorderAutopilot();
