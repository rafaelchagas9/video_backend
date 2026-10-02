import { open } from "node:fs/promises";

const BLOCK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

/** The OpenSubtitles hash used by Stash; reads only the first and last 64 KiB. */
export function oshashBlocks(
  size: number,
  first: Buffer,
  last: Buffer
): string {
  if (size < BLOCK * 2 || first.length !== BLOCK || last.length !== BLOCK) {
    throw new Error(
      "oshash requires complete boundary blocks and a file of at least 128 KiB"
    );
  }
  let checksum = BigInt(size);
  for (const block of [first, last]) {
    for (let position = 0; position < BLOCK; position += 8) {
      checksum = (checksum + block.readBigUInt64LE(position)) & MASK;
    }
  }
  return checksum.toString(16).padStart(16, "0");
}

export async function computeVideoOshash(filePath: string): Promise<string> {
  const file = await open(filePath, "r");
  try {
    const before = await file.stat();
    const size = before.size;
    if (size < BLOCK * 2)
      throw new Error("oshash requires a file of at least 128 KiB");
    const first = Buffer.alloc(BLOCK);
    const last = Buffer.alloc(BLOCK);
    const firstRead = await file.read(first, 0, BLOCK, 0);
    const lastRead = await file.read(last, 0, BLOCK, size - BLOCK);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(
        "Video changed while its fingerprint was being calculated"
      );
    }
    return oshashBlocks(
      size,
      first.subarray(0, firstRead.bytesRead),
      last.subarray(0, lastRead.bytesRead)
    );
  } finally {
    await file.close();
  }
}
