import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeFileHash,
  fileExists,
  formatBytes,
  getFileSize,
  isVideoFile,
} from "@/utils/file-utils";

describe("file utilities", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "conversor-video-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects supported video file extensions case-insensitively", () => {
    expect(isVideoFile("/media/movie.MP4")).toBe(true);
    expect(isVideoFile("/media/movie.webm")).toBe(true);
    expect(isVideoFile("/media/subtitles.srt")).toBe(false);
  });

  it("checks existence and reads file size", async () => {
    const filePath = join(tempDir, "sample.webm");
    await writeFile(filePath, "video-bytes");

    expect(fileExists(filePath)).toBe(true);
    expect(fileExists(join(tempDir, "missing.webm"))).toBe(false);
    expect(await getFileSize(filePath)).toBe(11);
  });

  it("computes stable 32-character hashes for small files", async () => {
    const firstPath = join(tempDir, "first.mp4");
    const secondPath = join(tempDir, "second.mp4");
    const thirdPath = join(tempDir, "third.mp4");

    await writeFile(firstPath, "same-content");
    await writeFile(secondPath, "same-content");
    await writeFile(thirdPath, "different-content");

    const firstHash = await computeFileHash(firstPath);
    const secondHash = await computeFileHash(secondPath);
    const thirdHash = await computeFileHash(thirdPath);

    expect(firstHash).toMatch(/^[0-9a-f]{32}$/);
    expect(firstHash).toBe(secondHash);
    expect(firstHash).not.toBe(thirdHash);
  });

  it("formats byte counts for common units", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
    expect(formatBytes(512)).toBe("512 Bytes");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1 MB");
  });
});
