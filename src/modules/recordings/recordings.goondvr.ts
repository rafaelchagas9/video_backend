/** GoondVR's JSON API (live recorder). Basic auth when configured. */
import { env } from "@/config/env";
import { AppError } from "@/utils/errors";

/** A channel snapshot exactly as GoondVR reports it: raw seconds, bytes and Unix times. */
export interface GoondvrChannel {
  id: string;
  username: string;
  site: string;
  is_online: boolean;
  is_paused: boolean;
  /** Seconds of the current recording session, 0 when idle. */
  duration_seconds: number;
  file_size_bytes: number;
  total_disk_usage_bytes: number;
  streamed_at?: number;
  created_at: number;
  framerate: number;
  resolution: number;
  pattern: string;
  max_duration_minutes: number;
  max_file_size_mb: number;
  stored_duration_seconds: number;
  max_stored_duration_minutes: number;
  max_stored_size_mb: number;
  pause_reason?: string;
  room_title?: string;
  viewer_count: number;
  has_thumbnail: boolean;
  has_live_thumbnail: boolean;
  logs: string[] | null;
}

export interface GoondvrRecording {
  id: string;
  channel_id: string;
  username: string;
  name: string;
  size_bytes: number;
  active: boolean;
  completed: boolean;
}

export interface GoondvrStats {
  disk_used_bytes: number;
  disk_total_bytes: number;
  disk_percent: number;
  uptime_seconds: number;
  recording_count: number;
}

export interface GoondvrSettings {
  completed_dir: string;
  finalize_mode: string;
  ffmpeg_encoder: string;
  ffmpeg_container: string;
  ffmpeg_quality: number;
  ffmpeg_preset: string;
  disk_warning_percent: number;
  disk_critical_percent: number;
  cf_channel_threshold: number;
  cf_global_threshold: number;
  notify_cooldown_hours: number;
  notify_stream_online: boolean;
  cookies_configured: boolean;
  user_agent_configured: boolean;
  ntfy_configured: boolean;
  discord_webhook_configured: boolean;
}

/** GoondVR replaces every non-secret field on save, so updates carry the whole set. */
export type GoondvrSettingsUpdate = Omit<GoondvrSettings, `${string}_configured`> & {
  cookies?: string;
  user_agent?: string;
  ntfy_url?: string;
  ntfy_topic?: string;
  ntfy_token?: string;
  discord_webhook_url?: string;
};

export interface GoondvrChannelConfig {
  username: string;
  site: string;
  framerate: number;
  resolution: number;
  pattern: string;
  max_duration: number;
  max_filesize: number;
  max_stored_duration: number;
  max_stored_size_mb: number;
  auto_start?: boolean;
}

/** GoondVR's own default naming: per-site folders, and a sequence suffix on split files. */
export const GOONDVR_DEFAULT_PATTERN =
  'videos/{{if ne .Site "chaturbate"}}{{.Site}}/{{end}}{{.Username}}_{{.Year}}-{{.Month}}-{{.Day}}_{{.Hour}}-{{.Minute}}-{{.Second}}{{if .Sequence}}_{{.Sequence}}{{end}}';

export type GoondvrEvent =
  | { type: "channel.updated" | "channel.logs" | "channel.thumbnail"; channel: GoondvrChannel }
  | { type: "channel.removed"; channel_id: string };

function headers(): Record<string, string> {
  if (!env.GOONDVR_USERNAME) return {};
  const token = Buffer.from(`${env.GOONDVR_USERNAME}:${env.GOONDVR_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  return fetch(`${env.GOONDVR_API_URL}${path}`, {
    ...init,
    headers: {
      ...headers(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function list<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const value = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * A call the user asked for: GoondVR's own error message and status come back
 * verbatim (a quota still exhausted is its 409), and an unreachable recorder is a 502.
 */
async function command<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  let response: Response;
  try {
    response = await request(path, init, 20_000);
  } catch {
    throw new AppError(502, "GoondVR is not reachable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new AppError(response.status >= 500 ? 502 : response.status, body?.error || `GoondVR answered ${response.status}`);
  }
  return response.status === 204 ? null : ((await response.json().catch(() => null)) as T | null);
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const goondvr = {
  /** Every channel, or null when GoondVR cannot be reached. */
  async channels(): Promise<GoondvrChannel[] | null> {
    try {
      const response = await request("/channels");
      if (!response.ok) return null;
      return list<GoondvrChannel>(await response.json(), "channels");
    } catch {
      return null;
    }
  },

  async meta(): Promise<{ version: string } | null> {
    try {
      const response = await request("/meta");
      return response.ok ? ((await response.json()) as { version: string }) : null;
    } catch {
      return null;
    }
  },

  async stats(): Promise<GoondvrStats | null> {
    try {
      const response = await request("/stats");
      return response.ok ? ((await response.json()) as GoondvrStats) : null;
    } catch {
      return null;
    }
  },

  async recordings(): Promise<GoondvrRecording[]> {
    try {
      const response = await request("/recordings");
      if (!response.ok) return [];
      return list<GoondvrRecording>(await response.json(), "recordings");
    } catch {
      return [];
    }
  },

  /** Deleting through GoondVR keeps its per-channel quota counters truthful. */
  async deleteRecording(id: string): Promise<boolean> {
    try {
      const response = await request(`/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
      return response.ok;
    } catch {
      return false;
    }
  },

  /** The live frame, or (`summary`) the site's profile image. */
  async thumbnail(channelId: string, kind: "live" | "summary" = "live"): Promise<Response | null> {
    try {
      const path = kind === "live" ? "live-thumbnail" : "thumbnail";
      const response = await request(`/channels/${encodeURIComponent(channelId)}/${path}`);
      return response.ok ? response : null;
    } catch {
      return null;
    }
  },

  /**
   * One file of a channel's in-memory live HLS view: `index.m3u8`, or a segment
   * it lists. A playlist request may wait up to 15 s for a stream that is
   * starting; GoondVR's own status (404 nothing to watch, 503 starting) comes
   * back as is. Null when GoondVR cannot be reached.
   */
  async live(channelId: string, file: string): Promise<Response | null> {
    try {
      return await request(`/channels/${encodeURIComponent(channelId)}/live/${encodeURIComponent(file)}`, {}, 25_000);
    } catch {
      return null;
    }
  },

  createChannel(config: GoondvrChannelConfig) {
    return command<GoondvrChannel[]>("/channels", { method: "POST", ...json(config) });
  },

  /** Saving restarts the monitor, finalizing the file in progress first. */
  updateChannel(channelId: string, config: GoondvrChannelConfig) {
    return command<GoondvrChannel>(`/channels/${encodeURIComponent(channelId)}`, { method: "PUT", ...json(config) });
  },

  pauseChannel(channelId: string) {
    return command(`/channels/${encodeURIComponent(channelId)}/pause`, { method: "POST" });
  },

  resumeChannel(channelId: string) {
    return command(`/channels/${encodeURIComponent(channelId)}/resume`, { method: "POST" });
  },

  removeChannel(channelId: string) {
    return command(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
  },

  settings() {
    return command<GoondvrSettings>("/settings");
  },

  updateSettings(update: GoondvrSettingsUpdate) {
    return command<GoondvrSettings>("/settings", { method: "PUT", ...json(update) });
  },

  /**
   * Follows GoondVR's event stream until `signal` aborts, reconnecting with
   * backoff. `onConnect` runs on every (re)connect: the stream does not replay
   * what was missed, so callers refetch there.
   */
  async follow(signal: AbortSignal, onEvent: (event: GoondvrEvent) => void, onConnect: () => void): Promise<void> {
    let delay = 2_000;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${env.GOONDVR_API_URL}/events?stream=updates`, {
          headers: { ...headers(), Accept: "text/event-stream" },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
        delay = 2_000;
        onConnect();
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as GoondvrEvent);
            } catch {
              // Heartbeats and anything malformed are skipped.
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  },
};

/** Recordings are named `<username>_YYYY-MM-DD_HH-MM-SS.<ext>` by GoondVR's default pattern. */
export function usernameFromFileName(fileName: string): string | null {
  return /^(.+?)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.exec(fileName)?.[1] ?? null;
}
