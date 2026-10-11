/** Bounded, user-specific negative cache. No persistence or database access. */
export class RelatedEmptyCache {
  private readonly entries = new Map<string, number>();
  private revision = 0;
  get generation(): number { return this.revision; }
  constructor(private readonly ttlMs = 60_000, private readonly maxEntries = 500) {}

  get(userId: number, videoId: number, now = Date.now()): Date | null {
    const key = `${userId}:${videoId}`;
    const computedAt = this.entries.get(key);
    if (computedAt === undefined) return null;
    if (now - computedAt >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return new Date(computedAt);
  }

  remember(
    userId: number, videoId: number, now = Date.now(), generation = this.generation,
  ): void {
    // Results computed before invalidation must not refill the cleared cache.
    if (generation !== this.generation) return;
    const key = `${userId}:${videoId}`;
    this.entries.delete(key);
    this.entries.set(key, now);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  forget(userId: number, videoId: number): void {
    this.entries.delete(`${userId}:${videoId}`);
  }

  clear(): void {
    this.revision += 1;
    this.entries.clear();
  }
}
