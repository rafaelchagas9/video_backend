export interface BufferedAnalysisFrame {
  index: number;
  ptsSeconds: number;
  image: Blob;
}

interface CachedWindow {
  startSeconds: number;
  endSeconds: number;
  interval: number;
  frames: readonly BufferedAnalysisFrame[];
  bytes: number;
}

/** Private to one run, so source/model/config changes can never reuse these images. */
export class RefinementFrameCache {
  private readonly windows = new Map<string, CachedWindow>();
  private bytes = 0;
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error("Invalid refinement cache budget");
  }
  get size(): number {
    return this.windows.size;
  }
  get byteSize(): number {
    return this.bytes;
  }
  private key(start: number, interval: number): string {
    return `${start}:${interval}`;
  }

  put(
    startSeconds: number,
    endSeconds: number,
    interval: number,
    frames: readonly BufferedAnalysisFrame[]
  ): void {
    const bytes = frames.reduce((total, frame) => total + frame.image.size, 0);
    if (this.maxBytes <= 0 || bytes > this.maxBytes) return;
    const key = this.key(startSeconds, interval);
    this.remove(key);
    while (this.bytes + bytes > this.maxBytes || this.windows.size >= 16_384)
      this.remove(this.windows.keys().next().value!);
    this.windows.set(key, {
      startSeconds,
      endSeconds,
      interval,
      frames,
      bytes,
    });
    this.bytes += bytes;
  }

  take(
    startSeconds: number,
    endSeconds: number,
    interval: number
  ): BufferedAnalysisFrame[] | undefined {
    const key = this.key(startSeconds, interval);
    const cached = this.windows.get(key);
    // A prefix with the same sampling origin is equivalent. A shifted origin is not.
    if (!cached || cached.endSeconds < endSeconds) return undefined;
    this.remove(key);
    return cached.frames
      .filter(
        (frame) =>
          frame.ptsSeconds >= startSeconds && frame.ptsSeconds < endSeconds
      )
      .map((frame, index) => ({ ...frame, index }));
  }

  private remove(key: string): void {
    const cached = this.windows.get(key);
    if (!cached) return;
    this.bytes -= cached.bytes;
    this.windows.delete(key);
  }
}
