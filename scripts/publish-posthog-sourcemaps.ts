#!/usr/bin/env bun

const requiredEnvironment = [
  "POSTHOG_CLI_HOST",
  "POSTHOG_CLI_PROJECT_ID",
  "POSTHOG_CLI_API_KEY",
  "POSTHOG_SERVICE_VERSION",
] as const;

const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name],
);

if (missingEnvironment.length > 0) {
  throw new Error(
    `Refusing to upload source maps without explicit CI credentials: ${missingEnvironment.join(", ")}`,
  );
}

const cliPath = "./node_modules/.bin/posthog-cli";
const outputDirectory = "./dist";
const releaseName = "video-streaming-backend";
const releaseVersion = process.env.POSTHOG_SERVICE_VERSION!;
const releaseArgs = [
  "--release-name",
  releaseName,
  "--release-version",
  releaseVersion,
];

async function runCli(args: string[]): Promise<void> {
  const processHandle = Bun.spawn([cliPath, ...args], {
    cwd: import.meta.dir + "/..",
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await processHandle.exited;

  if (exitCode !== 0) {
    throw new Error(`posthog-cli ${args.join(" ")} failed with code ${exitCode}`);
  }
}

// This command is deliberately separate from `build`. Source maps contain
// source context and must only leave the machine when CI credentials are set.
await runCli([
  "sourcemap",
  "inject",
  "--directory",
  outputDirectory,
  ...releaseArgs,
]);
await runCli([
  "sourcemap",
  "upload",
  "--directory",
  outputDirectory,
  ...releaseArgs,
  "--delete-after",
]);
