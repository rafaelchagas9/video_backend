/** Inputs for the review guide: the queue as the overview lists it, plus what was reviewed so far. */
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { goondvr } from "./recordings.goondvr";
import { buildGuide, type ChannelHistory, type CreatorLook, type GuideProgressInput, type GuideQueueInput, type RecordingGuide } from "./recordings.guide.policy";

/** Latest analysis generation per recording, merged-away rows left out. */
const latest = sql`
  SELECT f.* FROM recording_clip_feedback f
  JOIN (SELECT video_id, max(analyzed_at) a FROM recording_clip_feedback GROUP BY video_id) l
    ON l.video_id = f.video_id AND l.a = f.analyzed_at
  WHERE f.merged_into IS NULL`;

async function history(): Promise<Map<string, ChannelHistory>> {
  const rows = await db.execute<{ channel: string; recordings: number; highlight_recordings: number; keeps: number }>(sql`
    SELECT lower(regexp_replace(channel, '^@', '')) AS channel, count(DISTINCT video_id)::int AS recordings,
      count(DISTINCT video_id) FILTER (WHERE label_type = 'highlight')::int AS highlight_recordings,
      count(*) FILTER (WHERE verdict = 'keep')::int AS keeps
    FROM (${latest}) f WHERE channel IS NOT NULL AND channel <> '' GROUP BY 1`);
  return new Map(rows.map((row) => [row.channel, { recordings: Number(row.recordings), highlightRecordings: Number(row.highlight_recordings), keeps: Number(row.keeps) }]));
}

async function progress(): Promise<GuideProgressInput> {
  const [row] = await db.execute<{ highlight_recordings: number; highlight_channels: number; whole_streams: number; worth_open: number }>(sql`
    WITH f AS (${latest})
    SELECT
      (SELECT count(DISTINCT video_id) FROM f WHERE label_type = 'highlight')::int AS highlight_recordings,
      (SELECT count(DISTINCT lower(channel)) FROM f WHERE label_type = 'highlight' AND channel IS NOT NULL)::int AS highlight_channels,
      (SELECT count(DISTINCT video_id) FROM f WHERE verdict = 'keep' AND reasons ? 'keep_whole')::int AS whole_streams,
      (SELECT count(*) FROM recording_label_tasks WHERE kind = 'refine' AND answer IS NULL)::int AS worth_open`);
  return {
    highlightRecordings: Number(row?.highlight_recordings ?? 0),
    highlightChannels: Number(row?.highlight_channels ?? 0),
    wholeStreams: Number(row?.whole_streams ?? 0),
    worthOpen: Number(row?.worth_open ?? 0),
  };
}

/** The demo has no personal review history; these stand-ins give the guide its real shape. */
const DEMO_HISTORY = new Map<string, ChannelHistory>([
  ["demo_regular", { recordings: 11, highlightRecordings: 6, keeps: 19 }],
  ["demo_promising", { recordings: 2, highlightRecordings: 2, keeps: 7 }],
  ["demo_newcomer", { recordings: 1, highlightRecordings: 1, keeps: 3 }],
  ["demo_quiet", { recordings: 4, highlightRecordings: 0, keeps: 0 }],
  // The real library has dozens of channels; the demo needs as many to show the lists at scale.
  ...Array.from({ length: 48 }, (_, index): [string, ChannelHistory] => {
    const recordings = 1 + (index % 3);
    return [`demo_channel_${String(index + 1).padStart(2, "0")}`, { recordings, highlightRecordings: recordings, keeps: 1 + ((index * 7) % 9) }];
  }),
]);
const DEMO_PROGRESS: GuideProgressInput = { highlightRecordings: 28, highlightChannels: 15, wholeStreams: 3, worthOpen: 134 };

/** A creator's social link to a channel page, and the channel name in it. */
const CHANNEL_URL = String.raw`(chaturbate\.com|stripchat\.com|kick\.com|twitch\.tv|youtube\.com)/@?[^/?#]+/?$`;
const CHANNEL_NAME = String.raw`^.*/@?([^/?#]+)/?$`;

/**
 * Faces for the channel lists: the Kura creator a channel belongs to (same rule as linking a
 * recording to its creator: a social link to the channel page, or the same name), and the GoondVR
 * channel, whose profile image stands in when the creator has no picture.
 */
async function looks(channels: readonly string[]): Promise<Map<string, CreatorLook>> {
  if (!channels.length) return new Map();
  const [rows, live] = await Promise.all([
    db.execute<{ channel: string; creator_id: number | null; has_picture: boolean | null }>(sql`
      SELECT u.channel, c.id AS creator_id, c.profile_picture_path IS NOT NULL AS has_picture
      FROM unnest(ARRAY[${sql.join(channels.map((channel) => sql`${channel}`), sql`, `)}]::text[]) AS u(channel)
      LEFT JOIN LATERAL (
        SELECT c.id, c.profile_picture_path FROM creators c
        WHERE lower(c.name) = u.channel OR EXISTS (
          SELECT 1 FROM creator_social_links l WHERE l.creator_id = c.id
            AND lower(l.url) ~ ${CHANNEL_URL}
            AND lower(regexp_replace(l.url, ${CHANNEL_NAME}, ${"\\1"})) = u.channel)
        ORDER BY (c.profile_picture_path IS NULL), c.id LIMIT 1
      ) c ON true`),
    goondvr.channels().catch(() => null),
  ]);
  const channelIds = new Map((live ?? []).map((channel) => [channel.username.toLowerCase().replace(/^@/, ""), channel.id]));
  return new Map(rows.map((row) => [row.channel, {
    creatorId: row.creator_id === null ? null : Number(row.creator_id),
    hasPicture: Boolean(row.has_picture),
    channelId: channelIds.get(row.channel) ?? null,
  }]));
}

export async function recordingGuide(queue: readonly GuideQueueInput[]): Promise<RecordingGuide> {
  if (env.DEMO_MODE) return buildGuide(queue, DEMO_HISTORY, DEMO_PROGRESS);
  const [seen, done] = await Promise.all([history(), progress()]);
  return buildGuide(queue, seen, done, await looks([...seen.keys()]));
}
