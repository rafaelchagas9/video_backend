process.env.DEMO_SQLITE_TOOL = "true";

const {
  closeDemoDatabase,
  hasDemoSeed,
  initializeDemoDatabase,
  resetDemoRuntimeState,
} = await import("@/database/demo");

try {
  initializeDemoDatabase();
  if (!hasDemoSeed()) {
    throw new Error(
      "Demo SQLite database has no seed. Run `bun run demo:download` to build a fresh demo, or `bun run demo:migrate-json` for a legacy JSON migration."
    );
  }
  resetDemoRuntimeState();
  process.stdout.write("Restored demo SQLite from its immutable baseline\n");
} finally {
  closeDemoDatabase();
}
