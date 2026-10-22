import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@/config/env";
import { archiveSteps } from "@/modules/recordings/recordings.archive";

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "kura-archive-")); dirs.push(dir); return dir; };
const original = env.RECORDING_ARCHIVE_DIR;
afterEach(async () => {
  env.RECORDING_ARCHIVE_DIR = original;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("moving recordings to the NAS", () => {
  it("copies byte for byte, leaves no partial file, and reuses a proven earlier copy", async () => {
    const dir = await temp();
    const source = join(dir, "someone_2026-10-20_10-00-00.mp4");
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024 + 17, 7));
    const destination = join(dir, "copy.mp4");
    const first = await archiveSteps.verifiedCopy(source, destination);
    expect(await readFile(destination)).toEqual(await readFile(source));
    expect(await stat(`${destination}.partial`).catch(() => null)).toBeNull();
    const before = (await stat(destination)).mtimeMs;
    expect(await archiveSteps.verifiedCopy(source, destination)).toBe(first);
    expect((await stat(destination)).mtimeMs).toBe(before);
  });

  it("replaces a damaged earlier copy instead of trusting it", async () => {
    const dir = await temp();
    const source = join(dir, "a.mp4");
    const destination = join(dir, "b.mp4");
    await writeFile(source, "the real recording");
    await writeFile(destination, "a truncated copy");
    await archiveSteps.verifiedCopy(source, destination);
    expect(await readFile(destination, "utf8")).toBe("the real recording");
  });

  it("refuses an archive folder that is missing or on the recording's own disk", async () => {
    const dir = await temp();
    const source = join(dir, "a.mp4");
    await writeFile(source, "x");
    env.RECORDING_ARCHIVE_DIR = join(dir, "not-mounted");
    await expect(archiveSteps.assertNas(source)).rejects.toThrow("Is the NAS mounted?");
    // An unmounted share leaves an ordinary local folder behind: same disk, so refused.
    env.RECORDING_ARCHIVE_DIR = dir;
    await expect(archiveSteps.assertNas(source)).rejects.toThrow("same disk");
  });
});
