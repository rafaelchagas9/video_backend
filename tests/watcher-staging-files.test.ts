import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatcherService } from "@/modules/directories/watcher.service";

test("recursive discovery excludes incomplete conversion staging and preserves ordinary hidden media", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-staging-"));
  try {
    await mkdir(join(root, ".conversion-fixture"));
    await mkdir(join(root, ".archive"));
    await writeFile(join(root, "original.mkv"), "source fixture");
    await writeFile(
      join(root, ".conversion-fixture", "output.mkv"),
      "incomplete fixture"
    );
    await writeFile(join(root, ".archive", "personal.mkv"), "hidden fixture");
    const watcher = new WatcherService() as unknown as {
      findVideoFiles(path: string): Promise<string[]>;
    };
    const found = await watcher.findVideoFiles(root);
    expect(found.sort()).toEqual(
      [
        join(root, ".archive", "personal.mkv"),
        join(root, "original.mkv"),
      ].sort()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
