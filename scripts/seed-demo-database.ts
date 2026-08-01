process.env.DEMO_SQLITE_TOOL = "true";

const { closeDemoDatabase, hasDemoBaselineSnapshot, resetDemoRuntimeState } =
  await import("@/database/demo");

try {
  if (!hasDemoBaselineSnapshot()) {
    throw new Error(
      "Demo SQLite immutable baseline is missing. Run `bun run demo:download` to build a fresh demo, or `bun run demo:migrate-json` for a legacy JSON migration."
    );
  }
  resetDemoRuntimeState();
  process.stdout.write("Seeded demo SQLite from its immutable baseline\n");
} finally {
  closeDemoDatabase();
}
