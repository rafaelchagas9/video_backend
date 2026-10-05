/**
 * Kura as GoondVR's front end: channels with their creators, the commands that
 * drive them, the recorder's settings, and a relay of its event stream to every
 * signed-in client.
 */
import { sql } from "drizzle-orm";
import { API_PREFIX } from "@/config/constants";
import { db } from "@/config/drizzle";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { env } from "@/config/env";
import { creatorsService } from "@/modules/creators/creators.service";
import { creatorsSocialService } from "@/modules/creators/creators.social.service";
import { eventsService } from "@/modules/events/events.service";
import { AppError, BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  GOONDVR_DEFAULT_PATTERN,
  goondvr,
  type GoondvrChannel,
  type GoondvrChannelConfig,
  type GoondvrSettings,
  type GoondvrSettingsUpdate,
} from "./recordings.goondvr";

export const RECORDER_SITES = ["chaturbate", "stripchat", "twitch", "kick", "youtube"] as const;
export type RecorderSite = (typeof RECORDER_SITES)[number];

const SITE_LABELS: Record<RecorderSite, string> = {
  chaturbate: "Chaturbate",
  stripchat: "Stripchat",
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
};
const SITE_HOSTS: Record<string, RecorderSite> = {
  "chaturbate.com": "chaturbate",
  "stripchat.com": "stripchat",
  "twitch.tv": "twitch",
  "kick.com": "kick",
  "youtube.com": "youtube",
};

type CreatorRef = { id: number; name: string };

export interface LiveChannelInput {
  username: string;
  site: RecorderSite;
  resolution: number;
  framerate: number;
  split_minutes: number;
  split_mb: number;
  keep_minutes: number;
  keep_mb: number;
  auto_start?: boolean;
}

export type RecorderSettingsUpdate = Partial<
  Pick<
    GoondvrSettings,
    | "completed_dir"
    | "disk_warning_percent"
    | "disk_critical_percent"
    | "cf_channel_threshold"
    | "cf_global_threshold"
    | "notify_cooldown_hours"
    | "notify_stream_online"
  >
> &
  Pick<GoondvrSettingsUpdate, "cookies" | "user_agent" | "ntfy_url" | "ntfy_topic" | "ntfy_token" | "discord_webhook_url">;

/** `<site>:<username>` the way a channel and a creator's link both normalise to. */
const channelKey = (site: string, username: string) => `${site}:${username.replace(/^@/, "").toLowerCase()}`;

export function channelUrl(site: string, username: string): string {
  switch (site) {
    case "stripchat":
      return `https://stripchat.com/${username}`;
    case "twitch":
      return `https://www.twitch.tv/${username}`;
    case "kick":
      return `https://kick.com/${username}`;
    case "youtube":
      return /^UC[\w-]{22}$/.test(username)
        ? `https://www.youtube.com/channel/${username}`
        : `https://www.youtube.com/@${username.replace(/^@/, "")}`;
    default:
      return `https://chaturbate.com/${username}/`;
  }
}

/** The channel a profile URL points at, if it is on a site GoondVR records. */
export function channelFromUrl(url: string): { site: RecorderSite; username: string } | null {
  const match = /^(?:https?:\/\/)?(?:www\.|m\.)?([a-z]+\.(?:com|tv))\/([^?#]+)/i.exec(url.trim());
  const site = match ? SITE_HOSTS[match[1]!.toLowerCase()] : undefined;
  if (!match || !site) return null;
  const path = match[2]!.replace(/\/+$/, "").replace(/\/live$/, "");
  const username = site === "youtube" ? path.replace(/^channel\//, "") : path.split("/")[0]!;
  return username ? { site, username } : null;
}

function toLive(channel: GoondvrChannel, creator: CreatorRef | null) {
  return {
    id: channel.id,
    username: channel.username,
    site: channel.site,
    online: channel.is_online,
    paused: channel.is_paused,
    pause_reason: channel.pause_reason || null,
    recording_seconds: channel.duration_seconds ?? 0,
    recording_bytes: channel.file_size_bytes ?? 0,
    // Room titles are often explicit; the demo shows a neutral line instead.
    room_title: env.DEMO_MODE ? (channel.is_online ? "Live show" : "") : (channel.room_title ?? ""),
    viewers: channel.viewer_count ?? 0,
    has_thumbnail: Boolean(channel.has_live_thumbnail),
    has_summary: Boolean(channel.has_thumbnail),
    streamed_at: channel.streamed_at || null,
    created_at: channel.created_at,
    resolution: channel.resolution,
    framerate: channel.framerate,
    split_minutes: channel.max_duration_minutes ?? 0,
    split_mb: channel.max_file_size_mb ?? 0,
    keep_minutes: channel.max_stored_duration_minutes ?? 0,
    keep_mb: channel.max_stored_size_mb ?? 0,
    stored_seconds: channel.stored_duration_seconds ?? 0,
    stored_bytes: channel.total_disk_usage_bytes ?? 0,
    logs: (channel.logs ?? []).slice(-40),
    creator,
  };
}

export type LiveChannel = ReturnType<typeof toLive>;

/**
 * Which creator each channel belongs to: one whose social links point at the
 * channel, else one named exactly like it. Held for a minute, rebuilt with one
 * query, so a relayed event never waits on the database.
 */
class CreatorIndex {
  private byChannel = new Map<string, CreatorRef>();
  private byName = new Map<string, CreatorRef>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  invalidate() {
    this.loadedAt = 0;
  }

  async lookup(site: string, username: string): Promise<CreatorRef | null> {
    await this.fresh();
    const key = channelKey(site, username);
    return this.byChannel.get(key) ?? this.byName.get(key.slice(key.indexOf(":") + 1)) ?? null;
  }

  private async fresh() {
    if (Date.now() - this.loadedAt < 60_000) return;
    this.loading ??= this.load().finally(() => (this.loading = null));
    await this.loading;
  }

  private async load() {
    const { links, names } = env.DEMO_MODE ? demoCreatorRows() : await creatorRows();
    const byChannel = new Map<string, CreatorRef>();
    for (const link of links) {
      const channel = channelFromUrl(String(link.url));
      const key = channel && channelKey(channel.site, channel.username);
      if (key && !byChannel.has(key)) byChannel.set(key, { id: Number(link.id), name: String(link.name) });
    }
    const byName = new Map<string, CreatorRef>();
    for (const row of names) {
      const key = String(row.name).toLowerCase();
      if (!byName.has(key)) byName.set(key, { id: Number(row.id), name: String(row.name) });
    }
    this.byChannel = byChannel;
    this.byName = byName;
    this.loadedAt = Date.now();
  }
}

async function creatorRows() {
  const links = await db.execute<{ id: number; name: string; url: string }>(sql`
    SELECT c.id, c.name, l.url FROM creator_social_links l JOIN creators c ON c.id = l.creator_id
    WHERE l.url ~* '(chaturbate|stripchat|youtube|kick)\\.com/|twitch\\.tv/' ORDER BY c.id`);
  const names = await db.execute<{ id: number; name: string }>(sql`SELECT id, name FROM creators ORDER BY id`);
  return { links, names };
}

/** The demo keeps creators in its own SQLite database. */
function demoCreatorRows() {
  const { demoCreatorsTable, demoCreatorSocialLinksTable } = demoSchema;
  const database = getDemoDatabase();
  const names = database.select({ id: demoCreatorsTable.id, name: demoCreatorsTable.name }).from(demoCreatorsTable).all();
  const byId = new Map(names.map((row) => [row.id, row.name]));
  const links = database
    .select({ id: demoCreatorSocialLinksTable.creatorId, url: demoCreatorSocialLinksTable.url })
    .from(demoCreatorSocialLinksTable)
    .all()
    .flatMap((row) => (byId.has(row.id) ? [{ id: row.id, name: byId.get(row.id)!, url: row.url }] : []));
  return { links, names };
}

const creators = new CreatorIndex();

/**
 * The demo never shows a channel's real picture: a demo creator's portrait
 * stands in for the profile image and their main picture for the live frame —
 * the linked creator's own when it has one, otherwise a stable pick per channel.
 */
export async function demoChannelPicture(channelId: string, kind: "live" | "summary"): Promise<{ creatorId: number; variant: "portrait" | "main" } | null> {
  const { demoCreatorsTable } = demoSchema;
  const rows = getDemoDatabase()
    .select({ id: demoCreatorsTable.id, portrait: demoCreatorsTable.profilePicturePath, main: demoCreatorsTable.mainPicturePath })
    .from(demoCreatorsTable)
    .all();
  const variant = kind === "live" ? "main" : "portrait";
  const usable = rows.filter((row) => (variant === "main" ? row.main : row.portrait)).sort((a, b) => a.id - b.id);
  const [site = "", username = ""] = channelId.split("__");
  const linked = await creators.lookup(site, username).catch(() => null);
  const own = linked ? usable.find((row) => row.id === linked.id) : undefined;
  if (own) return { creatorId: own.id, variant };
  if (!usable.length) return null;
  return { creatorId: usable[stableIndex(channelId, usable.length)]!.id, variant };
}

/** Where a player finds a channel's live view: an HLS playlist, or in the demo a video file. */
export interface LiveWatch {
  kind: "hls" | "file";
  url: string;
}

function stableIndex(key: string, length: number): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % length;
}

/**
 * The demo never plays a real broadcast: one of the linked creator's demo
 * videos stands in, otherwise a stable pick per channel.
 */
async function demoStandInVideo(channelId: string): Promise<number | null> {
  const { demoVideosTable, demoVideoCreatorsTable } = demoSchema;
  const database = getDemoDatabase();
  const videos = database
    .select({ id: demoVideosTable.id, available: demoVideosTable.isAvailable })
    .from(demoVideosTable)
    .all()
    .filter((row) => row.available)
    .map((row) => row.id)
    .sort((a, b) => a - b);
  if (!videos.length) return null;
  const [site = "", username = ""] = channelId.split("__");
  const linked = await creators.lookup(site, username).catch(() => null);
  if (linked) {
    const available = new Set(videos);
    const own = database
      .select({ videoId: demoVideoCreatorsTable.videoId, creatorId: demoVideoCreatorsTable.creatorId })
      .from(demoVideoCreatorsTable)
      .all()
      .filter((row) => row.creatorId === linked.id && available.has(row.videoId))
      .map((row) => row.videoId)
      .sort((a, b) => a - b);
    if (own.length) return own[stableIndex(channelId, own.length)]!;
  }
  return videos[stableIndex(channelId, videos.length)]!;
}

/**
 * Relays GoondVR's events as `recorder:channel` / `recorder:removed`. GoondVR
 * sends a full snapshot for every segment it writes; updates are coalesced so
 * each channel reaches clients at most once a second.
 */
class RecorderRelay {
  private controller: AbortController | null = null;
  private pending = new Map<string, GoondvrChannel>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  start() {
    if (this.controller) return;
    this.controller = new AbortController();
    void goondvr.follow(
      this.controller.signal,
      (event) => {
        if (event.type === "channel.removed") {
          this.pending.delete(event.channel_id);
          eventsService.broadcast({ type: "recorder:removed", message: { id: event.channel_id } });
          return;
        }
        if (!event.channel) return;
        this.pending.set(event.channel.id, event.channel);
        this.timer ??= setTimeout(() => void this.flush(), 1_000);
      },
      () => logger.info("Following GoondVR events")
    );
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async flush() {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const channel of batch) {
      const creator = await creators.lookup(channel.site, channel.username).catch(() => null);
      eventsService.broadcast({ type: "recorder:channel", message: toLive(channel, creator) });
    }
  }
}

export const recorderRelay = new RecorderRelay();

function configFor(input: LiveChannelInput, pattern: string): GoondvrChannelConfig {
  return {
    username: input.username.trim(),
    site: input.site,
    framerate: input.framerate,
    resolution: input.resolution,
    pattern,
    max_duration: input.split_minutes,
    max_filesize: input.split_mb,
    max_stored_duration: input.keep_minutes,
    max_stored_size_mb: input.keep_mb,
    ...(input.auto_start !== undefined ? { auto_start: input.auto_start } : {}),
  };
}

const visibleSettings = (settings: GoondvrSettings) => ({
  completed_dir: settings.completed_dir,
  disk_warning_percent: settings.disk_warning_percent || 80,
  disk_critical_percent: settings.disk_critical_percent || 90,
  cf_channel_threshold: settings.cf_channel_threshold || 5,
  cf_global_threshold: settings.cf_global_threshold || 3,
  notify_cooldown_hours: settings.notify_cooldown_hours || 4,
  notify_stream_online: settings.notify_stream_online,
  cookies_configured: settings.cookies_configured,
  user_agent_configured: settings.user_agent_configured,
  ntfy_configured: settings.ntfy_configured,
  discord_webhook_configured: settings.discord_webhook_configured,
});

export class RecorderService {
  async withCreators(channels: GoondvrChannel[]): Promise<LiveChannel[]> {
    const live = await Promise.all(
      channels.map(async (channel) => toLive(channel, await creators.lookup(channel.site, channel.username).catch(() => null)))
    );
    return live.sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        Number(a.paused) - Number(b.paused) ||
        (b.streamed_at ?? 0) - (a.streamed_at ?? 0) ||
        a.username.localeCompare(b.username)
    );
  }

  async live() {
    const [channels, stats, meta] = await Promise.all([goondvr.channels(), goondvr.stats(), goondvr.meta()]);
    return {
      reachable: channels !== null,
      version: meta?.version ?? null,
      channels: channels ? await this.withCreators(channels) : [],
      stats,
    };
  }

  /** The channel after a command, read back so limits and status are GoondVR's own. */
  private async channel(id: string): Promise<LiveChannel> {
    const channels = await goondvr.channels();
    if (!channels) throw new AppError(502, "GoondVR is not reachable");
    const channel = channels.find((entry) => entry.id === id);
    if (!channel) throw new NotFoundError("GoondVR has no such channel");
    return toLive(channel, await creators.lookup(channel.site, channel.username).catch(() => null));
  }

  async forCreator(creatorId: number): Promise<LiveChannel[]> {
    const [links, creator, channels] = await Promise.all([
      creatorsSocialService.getSocialLinks(creatorId),
      creatorsService.findById(creatorId).catch(() => null),
      goondvr.channels(),
    ]);
    if (!creator || !channels) return [];
    const keys = new Set(
      links.flatMap((link) => {
        const channel = channelFromUrl(link.url);
        return channel ? [channelKey(channel.site, channel.username)] : [];
      })
    );
    const name = creator.name.toLowerCase();
    const own = channels.filter(
      (channel) => keys.has(channelKey(channel.site, channel.username)) || channel.username.replace(/^@/, "").toLowerCase() === name
    );
    return this.withCreators(own);
  }

  async add(input: LiveChannelInput): Promise<LiveChannel> {
    const before = new Set((await goondvr.channels())?.map((channel) => channel.id) ?? []);
    const after = (await goondvr.createChannel(configFor(input, GOONDVR_DEFAULT_PATTERN))) ?? [];
    // GoondVR normalises the name (case, URL, @handle); the new id is the one that was not there before.
    const added = after.find((channel) => !before.has(channel.id));
    if (!added) throw new BadRequestError("That channel is already being recorded");
    return toLive(added, await creators.lookup(added.site, added.username).catch(() => null));
  }

  async update(id: string, input: LiveChannelInput): Promise<LiveChannel> {
    const current = (await goondvr.channels())?.find((channel) => channel.id === id);
    if (!current) throw new NotFoundError("GoondVR has no such channel");
    const saved = await goondvr.updateChannel(id, configFor({ ...input, auto_start: undefined }, current.pattern || GOONDVR_DEFAULT_PATTERN));
    return this.channel(saved?.id ?? id);
  }

  async pause(id: string): Promise<LiveChannel> {
    await goondvr.pauseChannel(id);
    return this.channel(id);
  }

  async resume(id: string): Promise<LiveChannel> {
    await goondvr.resumeChannel(id);
    return this.channel(id);
  }

  /**
   * Where to play a channel live. GoondVR serves the view from memory — from
   * its recorder, or for a paused channel from a watch-only session that the
   * playlist requests keep alive — so nothing is checked here: the playlist
   * itself answers 404 when there is nothing to watch.
   */
  async watch(id: string): Promise<LiveWatch> {
    if (env.DEMO_MODE) {
      const videoId = await demoStandInVideo(id);
      if (!videoId) throw new NotFoundError("The demo has no video to stand in for a live view");
      return { kind: "file", url: `${API_PREFIX}/videos/${videoId}/stream` };
    }
    return { kind: "hls", url: `${API_PREFIX}/recordings/live/channels/${encodeURIComponent(id)}/stream/index.m3u8` };
  }

  async remove(id: string) {
    await goondvr.removeChannel(id);
    return { id };
  }

  /** Links the channel to an existing creator, or creates one named after it. */
  async linkCreator(id: string, payload: { creator_id?: number; name?: string }): Promise<LiveChannel> {
    const channel = (await goondvr.channels())?.find((entry) => entry.id === id);
    if (!channel) throw new NotFoundError("GoondVR has no such channel");
    const site = (RECORDER_SITES as readonly string[]).includes(channel.site) ? (channel.site as RecorderSite) : "chaturbate";
    const url = channelUrl(site, channel.username);
    let creatorId = payload.creator_id;
    if (!creatorId) {
      const name = payload.name?.trim() || channel.username.replace(/^@/, "");
      creatorId = (await creatorsService.create({ name })).id;
    }
    const key = channelKey(site, channel.username);
    const links = await creatorsSocialService.getSocialLinks(creatorId);
    const linked = links.some((link) => {
      const linkedChannel = channelFromUrl(link.url);
      return linkedChannel !== null && channelKey(linkedChannel.site, linkedChannel.username) === key;
    });
    if (!linked) {
      await creatorsSocialService.addSocialLink(creatorId, { platform_name: SITE_LABELS[site], url });
    }
    creators.invalidate();
    return this.channel(id);
  }

  async settings() {
    const settings = await goondvr.settings();
    if (!settings) throw new AppError(502, "GoondVR returned no settings");
    return visibleSettings(settings);
  }

  /**
   * GoondVR replaces every plain field on save, so the change is laid over its
   * current values. Finalization stays off: GoondVR keeps its own ffmpeg out of
   * the files, and conversion happens in Kura.
   */
  async updateSettings(update: RecorderSettingsUpdate) {
    const current = await goondvr.settings();
    if (!current) throw new AppError(502, "GoondVR returned no settings");
    const visible = visibleSettings(current);
    const next = { ...visible, ...update };
    if (next.disk_warning_percent >= next.disk_critical_percent) {
      throw new BadRequestError("The warning level must be below the critical level");
    }
    const saved = await goondvr.updateSettings({
      ...update,
      completed_dir: next.completed_dir,
      disk_warning_percent: next.disk_warning_percent,
      disk_critical_percent: next.disk_critical_percent,
      cf_channel_threshold: next.cf_channel_threshold,
      cf_global_threshold: next.cf_global_threshold,
      notify_cooldown_hours: next.notify_cooldown_hours,
      notify_stream_online: next.notify_stream_online,
      finalize_mode: "none",
      ffmpeg_encoder: current.ffmpeg_encoder,
      ffmpeg_container: current.ffmpeg_container,
      ffmpeg_quality: current.ffmpeg_quality,
      ffmpeg_preset: current.ffmpeg_preset,
    });
    if (!saved) throw new AppError(502, "GoondVR returned no settings");
    return visibleSettings(saved);
  }
}

export const recorderService = new RecorderService();
