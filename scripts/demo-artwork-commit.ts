import { existsSync } from "fs";
import { rename, rm } from "fs/promises";

export type DemoArtworkCommitOptions<TSnapshot> = {
  outputRoot: string;
  stagingRoot: string;
  backupRoot: string;
  captureDatabaseSnapshot: () => TSnapshot;
  replaceDatabase: () => void;
  restoreDatabaseSnapshot: (snapshot: TSnapshot) => void;
  createBaselineSnapshot: () => string;
};

/**
 * Install a fully rendered artwork directory and its database rows as one
 * recoverable operation. The baseline writer is itself atomic, so any failure
 * before it returns can restore both the previous directory and database rows.
 */
export async function commitStagedDemoArtwork<TSnapshot>(
  options: DemoArtworkCommitOptions<TSnapshot>
): Promise<string> {
  const previousDatabase = options.captureDatabaseSnapshot();
  const hadPreviousOutput = existsSync(options.outputRoot);
  let previousOutputMoved = false;
  let stagedOutputInstalled = false;
  let databaseReplaced = false;

  await rm(options.backupRoot, { recursive: true, force: true });

  try {
    if (hadPreviousOutput) {
      await rename(options.outputRoot, options.backupRoot);
      previousOutputMoved = true;
    }
    await rename(options.stagingRoot, options.outputRoot);
    stagedOutputInstalled = true;

    databaseReplaced = true;
    options.replaceDatabase();
    const baselinePath = options.createBaselineSnapshot();

    await rm(options.backupRoot, { recursive: true, force: true }).catch(
      () => undefined
    );
    return baselinePath;
  } catch (cause) {
    const rollbackErrors: unknown[] = [];

    try {
      if (stagedOutputInstalled) {
        await rm(options.outputRoot, { recursive: true, force: true });
      }
      if (previousOutputMoved) {
        await rename(options.backupRoot, options.outputRoot);
      }
    } catch (error) {
      rollbackErrors.push(error);
    }

    if (databaseReplaced) {
      try {
        options.restoreDatabaseSnapshot(previousDatabase);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackErrors],
        "Demo artwork generation failed and could not be fully rolled back"
      );
    }
    throw cause;
  } finally {
    await rm(options.stagingRoot, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}
