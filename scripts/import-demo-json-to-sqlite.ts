import { resolve } from "path";
import { existsSync } from "fs";

process.env.DEMO_SQLITE_TOOL = "true";

const {
  closeDemoDatabase,
  createDemoBaselineSnapshot,
  hasDemoBaselineSnapshot,
  importDemoArtworkManifestFile,
  importDemoJsonFile,
} = await import("@/database/demo");

const args = process.argv.slice(2);
const ifEmpty = args.includes("--if-empty");
const pathArg = args.find((arg) => !arg.startsWith("--"));
const path = pathArg
  ? resolve(process.cwd(), pathArg)
  : resolve(
      process.cwd(),
      process.env.DEMO_ASSETS_DIR || "demo_mode",
      "demo_mode.json"
    );

try {
  const imported = importDemoJsonFile(path, { reset: !ifEmpty, ifEmpty });
  const artworkManifestPath = resolve(
    process.cwd(),
    process.env.DEMO_ASSETS_DIR || "demo_mode",
    "artwork",
    "manifest.json"
  );
  if (imported && existsSync(artworkManifestPath)) {
    importDemoArtworkManifestFile(artworkManifestPath);
  }
  if (imported) {
    const baselinePath = createDemoBaselineSnapshot();
    process.stdout.write(
      `Migrated legacy demo JSON from ${path} and wrote baseline ${baselinePath}\n`
    );
  } else if (!hasDemoBaselineSnapshot()) {
    throw new Error(
      "Demo SQLite contains data but has no immutable baseline. Run bun run demo:migrate-json without --if-empty to rebuild it."
    );
  } else {
    process.stdout.write(
      "Demo SQLite seed and immutable baseline already exist\n"
    );
  }
} finally {
  closeDemoDatabase();
}
