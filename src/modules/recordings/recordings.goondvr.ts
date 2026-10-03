/** GoondVR's JSON API (live recorder). Basic auth when configured; every call is best-effort. */
import { env } from "@/config/env";

export interface GoondvrChannel {
  id: string;
  username: string;
  site: string;
  is_online: boolean;
  is_paused: boolean;
  /** Seconds of the current recording session, 0 when idle. */
  duration_seconds: number;
  room_title: string;
  viewer_count: number;
  has_live_thumbnail: boolean;
  streamed_at: number | null;
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

function headers(): Record<string, string> {
  if (!env.GOONDVR_USERNAME) return {};
  const token = Buffer.from(`${env.GOONDVR_USERNAME}:${env.GOONDVR_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.GOONDVR_API_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(8_000),
  });
}

function list<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const value = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export const goondvr = {
  async channels(): Promise<GoondvrChannel[] | null> {
    try {
      const response = await request("/channels");
      if (!response.ok) return null;
      return list<GoondvrChannel>(await response.json(), "channels");
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

  async thumbnail(channelId: string): Promise<Response | null> {
    try {
      const response = await request(`/channels/${encodeURIComponent(channelId)}/live-thumbnail`);
      return response.ok ? response : null;
    } catch {
      return null;
    }
  },
};

/** Recordings are named `<username>_YYYY-MM-DD_HH-MM-SS.<ext>` by GoondVR's default pattern. */
export function usernameFromFileName(fileName: string): string | null {
  return /^(.+?)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.exec(fileName)?.[1] ?? null;
}
