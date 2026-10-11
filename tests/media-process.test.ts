import { expect, it } from "bun:test";
import { runMediaProcess } from "@/utils/media-process";

const options = { label: "Fixture process", timeoutMs: 5_000 };
const run = (
  code: string,
  extra: Partial<
    typeof options & {
      signal: AbortSignal;
      maxOutputBytes: number;
      includeStderr: boolean;
    }
  > = {}
) => runMediaProcess(process.execPath, ["-e", code], { ...options, ...extra });

it("captures stdout while draining and bounding noisy stderr", async () => {
  const result = await run(
    'process.stderr.write("x".repeat(200000)); process.stdout.write("ok");'
  );
  expect(result.stdout).toBe("ok");
  expect(result.stderr.length).toBeLessThanOrEqual(16_384);
});

it("reports nonzero exits and optional diagnostic tail", async () => {
  await expect(
    run('process.stderr.write("encoder failed"); process.exit(7);', {
      includeStderr: true,
    })
  ).rejects.toThrow("exit 7): encoder failed");
  await expect(
    run('process.stderr.write("private input"); process.exit(7);')
  ).rejects.toThrow("Fixture process failed (exit 7)");
});

it("rejects missing executables", async () => {
  await expect(
    runMediaProcess("/nonexistent-isolated-media-executable", [], options)
  ).rejects.toThrow("could not start");
});

it("never spawns an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runMediaProcess("/nonexistent-isolated-media-executable", [], {
      ...options,
      signal: controller.signal,
    })
  ).rejects.toThrow("cancelled");
});

it("cancels and reaps a child before rejecting", async () => {
  const controller = new AbortController();
  const pending = run("setInterval(() => {}, 1000);", {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
});

it("terminates timed out and oversized-output processes", async () => {
  await expect(
    run("setInterval(() => {}, 1000);", { timeoutMs: 25 })
  ).rejects.toThrow("timed out");
  await expect(
    run(
      'process.stdout.write("x".repeat(20000)); setInterval(() => {}, 1000);',
      { maxOutputBytes: 100 }
    )
  ).rejects.toThrow("output is too large");
});
