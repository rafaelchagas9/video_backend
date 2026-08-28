import { existsSync } from "fs";

const files = process.argv.slice(2);

if (files.length === 0) {
  throw new Error("Usage: bun run test:files -- <test-file> [test-file ...]");
}

for (const file of files) {
  if (!file.endsWith(".test.ts") || !existsSync(file)) {
    throw new Error(`Refusing invalid test file: ${file}`);
  }

  console.log(`== ${file} ==`);
  const process = Bun.spawn(["bun", "test", "--max-concurrency=1", file], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: globalThis.process.env,
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    globalThis.process.exit(exitCode);
  }
}
