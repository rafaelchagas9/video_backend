# Video editing API: per-segment effects delta

This document contains only the additive changes for per-segment effects. All endpoints, job lifecycle rules, output settings, and top-level timeline effects remain as documented in the original frontend handoff.

## Request shape added

Each item in `timeline.segments` may now include optional `transform` and `audio` objects:

```json
{
  "timeline": {
    "segments": [
      {
        "start": 10,
        "end": 20,
        "speed": 1.25,
        "transform": {
          "crop": {
            "x": 0.1,
            "y": 0,
            "width": 0.8,
            "height": 1
          },
          "rotate": 90
        },
        "audio": {
          "muted": false,
          "volume": 0.7,
          "fade_in_seconds": 0.5,
          "fade_out_seconds": 1
        }
      }
    ]
  }
}
```

Equivalent additive TypeScript shape:

```ts
interface TimelineSegment {
  start: number;
  end: number;
  speed?: number;
  transform?: {
    crop?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    rotate?: 0 | 90 | 180 | 270;
  };
  audio?: {
    muted?: boolean;
    volume?: number; // 0 through 4
    fade_in_seconds?: number;
    fade_out_seconds?: number;
  };
}
```

All added fields are optional, so existing edit requests remain valid without migration.

## Processing semantics

- Segment effects are applied before the timeline segments are concatenated.
- Within a segment, crop is applied before rotation.
- When any segment has a crop or non-zero rotation, every segment is scaled and padded with black to a common, even-sized canvas matching the source video's dimensions. Aspect ratio is preserved. This makes differently cropped and rotated segments safe to concatenate without adding redundant normalization to audio-only edits.
- Segment audio effects are applied after that segment's speed adjustment.
- A muted segment keeps its full post-speed duration by contributing silence; it does not shorten or desynchronize the timeline.
- Segment fade durations are measured against the segment duration after speed adjustment: `(end - start) / speed`.
- Existing top-level `timeline.transform` and `timeline.audio` settings remain final effects. They compose after concatenation and do not replace per-segment settings.
- For a source without audio, audio settings remain accepted but the render stays video-only.

## Capabilities response delta

`GET /api/videos/:id/editing-metadata` now adds `timeline.segment_effects` under `data.capabilities`:

```json
{
  "timeline": {
    "segment_effects": {
      "transform": {
        "crop": "normalized",
        "rotate": [0, 90, 180, 270]
      },
      "audio": {
        "mute": true,
        "volume": { "min": 0, "max": 4 },
        "fades": true
      }
    }
  }
}
```

The existing top-level `capabilities.transform` and `capabilities.audio` entries are unchanged and still describe final, global effects.

## Demo mode

Demo mode accepts and validates the same per-segment fields, including normalized crop bounds, supported rotations, volume limits, and post-speed fade duration. It persists the complete timeline in its isolated SQLite job record and follows the existing deterministic demo lifecycle without running FFmpeg or reading personal media.

## Frontend action

No endpoint or polling changes are required. Extend each segment's editor state with optional transform/audio controls, send those values inside that segment, and use `capabilities.timeline.segment_effects` to feature-detect support. Existing global controls should remain distinct because they apply to the final concatenated timeline.
