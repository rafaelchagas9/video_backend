import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dependency preflight", () => {
  let directory: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dependency-check-"));
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  async function check(host = "127.0.0.1") {
    const child = Bun.spawn(
      [process.execPath, "scripts/check-dependencies.ts"],
      {
        env: {
          ...process.env,
          POSTGRES_HOST: host,
          POSTGRES_PORT: String(port),
          FFMPEG_PATH: process.execPath,
          FFPROBE_PATH: process.execPath,
          THUMBNAILS_DIR: directory,
          PROFILE_PICTURES_DIR: directory,
          LOGS_DIR: directory,
          STORYBOARDS_DIR: directory,
          CONVERTED_VIDEOS_DIR: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  it("checks a reachable local TCP endpoint without invoking a shell", async () => {
    const result = await check();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Accessible at 127.0.0.1:${port}`);
  });

  it("treats shell expressions in the hostname as invalid host data", async () => {
    const marker = join(directory, "unexpected-shell-execution");
    const result = await check(`$(touch ${marker})127.0.0.1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Not accessible");
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
