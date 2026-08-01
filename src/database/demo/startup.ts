import {
  hasDemoBaselineSnapshot,
  restoreDemoBaselineSnapshot,
} from "./baseline";
import { initializeDemoDatabase } from "./client";
import { hasDemoSeed } from "./seed";
import { resetDemoRuntimeAssets } from "./assets";

/** Prepare demo state without ever consulting the legacy JSON fixture. */
export function prepareDemoDatabaseForStartup(
  resetMode: "on-start" | "manual"
): void {
  initializeDemoDatabase();
  if (resetMode === "on-start" && hasDemoBaselineSnapshot()) {
    restoreDemoBaselineSnapshot();
    resetDemoRuntimeAssets();
  }
  if (!hasDemoSeed()) {
    throw new Error(
      "Demo SQLite database has no seed. Run `bun run demo:download` to build a fresh demo, or `bun run demo:migrate-json` for a legacy JSON migration."
    );
  }
  if (resetMode === "on-start" && !hasDemoBaselineSnapshot()) {
    throw new Error(
      "Demo SQLite immutable baseline is missing. Run `bun run demo:download` to build it, or `bun run demo:migrate-json` for a legacy JSON migration."
    );
  }
}
