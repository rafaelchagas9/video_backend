# Plan: Implement Media-Aware Video Conversion with VBR Encoding

## Problem Summary

Current video conversion uses CQP (Constant Quality Parameter) mode with no bitrate limits, causing:

- **File size increases** when downscaling (e.g., 4K→1080p with AV1)
- **Inefficient encoding** - ignores source video quality
- **No disk space control** - can produce files larger than source
- **Unused helper functions** - `getMaxRate()` and `getBufSize()` exist but aren't called

**Root cause**: Fixed QP values (22-24 for H.264/H.265, 30 for AV1) maintain quality level regardless of resolution. Without bitrate caps, encoder uses whatever bits needed to hit that quality.

## Solution Approach

**Priority: Balance quality and disk space**

Switch to VBR (Variable Bitrate) mode with intelligent bitrate calculation:

1. **Presets as ceilings** - Never exceed preset's max bitrate
2. **Source-aware** - Cap at source bitrate when it's lower than preset max
3. **Codec efficiency** - Account for AV1 > HEVC > H.264 compression ratios
4. **Quality floor** - Prevent over-compression with minimum quality parameter

## Implementation Plan

### Phase 1: Update Preset Configuration

**File**: `src/config/presets.ts`

**Changes**:

1. Add `maxBitrate` field to `ConversionPreset` interface:

   ```typescript
   export interface ConversionPreset {
     id: string;
     name: string;
     description: string;
     targetWidth: number | null;
     codec: CodecType;
     qp: number; // Now acts as quality FLOOR (prevents over-compression)
     maxBitrate: string | null; // NEW: Bitrate ceiling (e.g., "10M"), null = dynamic
     audioBitrate: string;
     container: "mkv";
   }
   ```

2. Populate `maxBitrate` for 1080p/720p presets using values from `getMaxRate()`:
   - **1080p**: H.264=20M, HEVC=15M, AV1=10M
   - **720p**: H.264=10M, HEVC=8M, AV1=6M
   - **Original**: `maxBitrate = null` → calculate dynamically from effective resolution (source width when keeping original)

3. Adjust QP values to act as quality floors (prevent blocking/artifacts):
   - H.264: 26 (was 22) - less aggressive quality demand
   - HEVC: 28 (was 24) - less aggressive quality demand
   - AV1: 35 (was 30) - balance file size and quality

**Rationale**: Higher QP = lower quality floor = smaller files. Combined with bitrate caps and VBR headroom, this balances size and visual quality.

### Phase 2: Add Bitrate Calculation Logic

**File**: `src/modules/conversion/conversion.service.ts`

**New method**: `calculateTargetBitrate()` (returns `bitrate`, `maxrate`, `bufsize`)

```typescript
private calculateTargetBitrate(
  video: Video,
  preset: ConversionPreset,
  targetWidth: number | null
): { bitrate: string; maxrate: string; bufsize: string } {
  const codecType = preset.codec.replace('_vaapi', '') as 'av1' | 'hevc' | 'h264';

  // Use preset max when scaling; otherwise derive from effective width
  const effectiveWidth = targetWidth ?? video.width ?? preset.targetWidth ?? 1920;
  const presetMaxBitrate = targetWidth
    ? (preset.maxBitrate ?? this.getMaxRate(targetWidth, codecType))
    : this.getMaxRate(effectiveWidth, codecType);

  const sourceBitrateMbps = video.bitrate
    ? Math.round(video.bitrate / 1_000_000)
    : null;

  const presetMaxMbps = parseInt(presetMaxBitrate.replace('M', ''), 10);
  let targetBitrateMbps = sourceBitrateMbps
    ? Math.min(presetMaxMbps, Math.round(sourceBitrateMbps * 1.1))
    : presetMaxMbps;

  targetBitrateMbps = Math.max(targetBitrateMbps, 1);

  const maxrateMbps = Math.min(
    presetMaxMbps,
    Math.max(targetBitrateMbps, Math.round(targetBitrateMbps * 1.2))
  );
  const bufsizeMbps = maxrateMbps * 2;

  return {
    bitrate: `${targetBitrateMbps}M`,
    maxrate: `${maxrateMbps}M`,
    bufsize: `${bufsizeMbps}M`
  };
}
```

**Key logic**:

- If source bitrate unknown → use preset max
- If source bitrate known → `min(preset_max, source * 1.1)`
- VBR headroom → `maxrate = min(preset_max, target * 1.2)`
- Minimum 1M prevents broken encodes

### Phase 3: Modify Encoder Options for VBR

**File**: `src/modules/conversion/conversion.service.ts`

**Update method**: `getEncoderOptions()`

**Current signature**:

```typescript
private getEncoderOptions(preset: ConversionPreset): string[]
```

**New signature**:

```typescript
private getEncoderOptions(
  preset: ConversionPreset,
  bitrate: string,
  maxrate: string,
  bufsize: string
): string[]
```

**New implementation** for AMD 7800XT with VAAPI:

```typescript
private getEncoderOptions(
  preset: ConversionPreset,
  bitrate: string,
  maxrate: string,
  bufsize: string
): string[] {
  const baseOptions = ['-async_depth', '4'];

  switch (preset.codec) {
    case 'av1_vaapi':
      return [
        ...baseOptions,
        '-rc_mode', 'VBR',              // Variable bitrate mode
        '-b:v', bitrate,                 // Target bitrate
        '-maxrate', maxrate,             // Ceiling with VBR headroom
        '-bufsize', bufsize,             // Buffer size (2x maxrate)
        '-global_quality', preset.qp.toString(), // Quality floor
      ];

    case 'hevc_vaapi':
      return [
        ...baseOptions,
        '-rc_mode', 'VBR',
        '-b:v', bitrate,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-qp', preset.qp.toString(),     // Quality floor
      ];

    case 'h264_vaapi':
      return [
        ...baseOptions,
        '-rc_mode', 'VBR',
        '-b:v', bitrate,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-qp', preset.qp.toString(),     // Quality floor
        '-profile:v', 'high',
      ];

    default:
      return ['-global_quality', preset.qp.toString()];
  }
}
```

**AMD 7800XT notes**:

- Uses VAAPI with Mesa drivers (`mesa-va-drivers`)
- VBR mode is well-supported for all three codecs
- `-async_depth 4` optimizes GPU pipeline depth
- Quality parameter (`-qp` or `-global_quality`) acts as a floor with VBR

### Phase 4: Update FFmpeg Execution

**File**: `src/modules/conversion/conversion.service.ts`

**Update method**: `runFfmpeg()`

**Current signature**:

```typescript
private runFfmpeg(
  jobId: number,
  inputPath: string,
  outputPath: string,
  preset: ConversionPreset,
  targetResolution: string | null
): Promise<void>
```

**New signature**:

```typescript
private runFfmpeg(
  jobId: number,
  video: Video,
  inputPath: string,
  outputPath: string,
  preset: ConversionPreset,
  targetResolution: string | null
): Promise<void>
```

**Changes**:

1. Accept `video` parameter to access source metadata
2. Calculate effective target width early:

   ```typescript
   const targetWidth = targetResolution
     ? parseInt(targetResolution.split("x")[0], 10)
     : null;
   ```

3. Call `calculateTargetBitrate()`:

   ```typescript
   const { bitrate, maxrate, bufsize } = this.calculateTargetBitrate(
     video,
     preset,
     targetWidth,
   );
   ```

4. Pass bitrate/maxrate to encoder options:

   ```typescript
   const encoderOptions = this.getEncoderOptions(
     preset,
     bitrate,
     maxrate,
     bufsize,
   );
   ```

5. Update FFmpeg args array to include encoder options

### Phase 5: Update Job Processing

**File**: `src/modules/conversion/conversion.service.ts`

**Update method**: `processJob()`

**Current code** (line 158):

```typescript
await this.runFfmpeg(
  jobId,
  inputPath,
  outputPath,
  preset,
  job.target_resolution,
);
```

**New code**:

```typescript
// Fetch video to get source metadata
const video = await videosService.findById(videoId);

await this.runFfmpeg(
  jobId,
  video,
  inputPath,
  outputPath,
  preset,
  job.target_resolution,
);
```

**Rationale**: Need source bitrate and dimensions for intelligent encoding decisions.

### Phase 6: Remove Unused Helper Functions (Optional Cleanup)

**File**: `src/modules/conversion/conversion.service.ts`

**Functions to remove** (lines 455-498):

- `getMaxRate()` - Move logic into `calculateTargetBitrate()`
- `getBufSize()` - Move logic into `calculateTargetBitrate()`

**Rationale**: Consolidate bitrate calculation in one place. The preset-based logic can be inlined.

Alternatively, **keep and refactor**:

- Make these functions static utilities
- Call them from `calculateTargetBitrate()`
- Improves testability

**Recommendation**: Keep and integrate (easier to test).

## Edge Cases & Validation

### Edge Case 1: No Source Bitrate

**Scenario**: Video metadata extraction failed, `video.bitrate = null`

**Handling**: Fall back to preset max bitrate

```typescript
if (!sourceBitrateMbps) {
  targetBitrateMbps = parseInt(presetMaxBitrate.replace("M", ""), 10);
}
```

### Edge Case 2: Very Low Source Bitrate

**Scenario**: Source is 480p with 500 Kbps (e.g., old phone video)

**Handling**:

- `source * 1.1 = 550 Kbps`
- Enforce minimum: `max(550K, 1M) = 1M`
- Prevents unusable quality

### Edge Case 3: Very High Source Bitrate

**Scenario**: 4K Blu-ray rip at 80 Mbps, converting to 1080p AV1

**Handling**:

- Preset max for 1080p AV1 = 10M
- Source \* 1.1 = 88M
- Result: `min(10M, 88M) = 10M` ✅
- Prevents overshooting preset ceiling

### Edge Case 4: Original Resolution Preset

**Scenario**: User selects "original_av1" for 4K video

**Handling**:

- `targetWidth = null` → use `video.width` (3840)
- Call `getMaxRate(3840, 'av1')` → "25M"
- Apply source-aware logic normally

### Edge Case 5: Upscaling Prevention

**Scenario**: 720p source, user selects 1080p preset

**Existing logic** in `calculateTargetResolution()` should prevent upscaling:

```typescript
// Don't upscale videos
if (preset.targetWidth && video.width && video.width < preset.targetWidth) {
  return "original";
}
```

**Bitrate impact**: Will use 720p bitrate limits, not 1080p (correct behavior).

## Testing Strategy

### Manual Testing

**Test Case 1: High bitrate 4K → 1080p AV1**

- Source: 4K video at 60 Mbps
- Preset: `1080p_av1`
- Expected: Output ≤ 10M bitrate, file size decrease

**Test Case 2: Low bitrate 1080p → 720p H.265**

- Source: 1080p video at 3 Mbps
- Preset: `720p_h265`
- Expected: Output ≤ 3.3M bitrate (source \* 1.1), file size similar or smaller

**Test Case 3: Unknown bitrate → 1080p H.264**

- Source: Video with `bitrate = null`
- Preset: `1080p_h264`
- Expected: Output uses preset max (20M), conversion succeeds

**Test Case 4: Original resolution with AV1**

- Source: 4K video at 40 Mbps
- Preset: `original_av1`
- Expected: Output ≤ 25M bitrate, file size decrease

### Verification Steps

After implementation:

1. **Start conversion** for each test case
2. **Monitor WebSocket events** for progress
3. **Check output file size**:
   ```bash
   ls -lh data/conversions/
   ```
4. **Verify bitrate** with FFprobe:
   ```bash
   ffprobe -v error -show_entries format=bit_rate \
     -of default=noprint_wrappers=1:nokey=1 output.mkv
   ```
5. **Compare input vs output**:
   - File size (should decrease for high-bitrate sources)
   - Bitrate (should not exceed preset max)
   - Quality (subjective visual check)

## Critical Files to Modify

| File                                           | Changes                                                                                                   | Lines   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `src/config/presets.ts`                        | Add `maxBitrate` field, adjust QP values                                                                  | 10-121  |
| `src/modules/conversion/conversion.service.ts` | Add `calculateTargetBitrate()`, update `getEncoderOptions()`, modify `runFfmpeg()`, update `processJob()` | 135-453 |

## Rollback Plan

If VBR mode causes issues:

1. **Revert encoder options** to CQP mode
2. **Keep bitrate calculation logic** but apply as `-maxrate` only:
   ```typescript
   return [
     ...baseOptions,
     "-rc_mode",
     "CQP",
     "-global_quality",
     preset.qp.toString(),
     "-maxrate",
     maxrate, // Add ceiling to CQP mode
     "-bufsize",
     bufsize,
   ];
   ```

This hybrid approach (CQP + maxrate) can prevent file size increases while maintaining quality-based encoding.

## Success Criteria

- ✅ 4K → 1080p conversions DECREASE file size (not increase)
- ✅ Output bitrate never exceeds preset maximum
- ✅ Low-bitrate sources don't get over-encoded
- ✅ Conversion jobs complete successfully on AMD 7800XT
- ✅ WebSocket progress updates still work
- ✅ No quality regression (subjective, should look "good enough")

## Additional Considerations

### AMD 7800XT VAAPI Setup

Ensure system has proper drivers:

```bash
# Check VAAPI support
vainfo

# Should show:
# - libva version
# - VA-API version
# - Driver: Mesa Gallium driver... for AMD Radeon...
# - Supported profiles including H.264, HEVC, AV1 encoding
```

If not working:

```bash
# Install Mesa VAAPI drivers
sudo pacman -S mesa-va-drivers  # Arch Linux
sudo apt install mesa-va-drivers  # Ubuntu/Debian
```

### Performance Impact

VBR mode may be slightly slower than CQP because:

- Encoder must hit bitrate targets (requires more analysis)

**Implementation**: Using single-pass VBR to maintain conversion speed.

### Future Enhancements

1. **Two-pass encoding** for optimal bitrate distribution
2. **Preset tiers**: "aggressive" (smaller files) vs "balanced" (current) vs "quality" (larger files)
3. **Smart preset selection**: Auto-suggest best preset based on source characteristics
4. **Batch optimization**: Analyze multiple files to recommend bulk conversion strategy
