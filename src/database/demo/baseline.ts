import { chmodSync, existsSync, renameSync, rmSync } from "fs";
import { Database } from "bun:sqlite";
import {
  getDemoDatabasePath,
  getDemoSqlite,
  initializeDemoDatabase,
} from "./client";

function quoteIdentifier(identifier: string): string {
  if (!/^demo_[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe demo baseline table identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function getDemoBaselinePath(): string {
  return `${getDemoDatabasePath()}.baseline`;
}

export function hasDemoBaselineSnapshot(): boolean {
  return existsSync(getDemoBaselinePath());
}

/**
 * Capture the fully imported catalog and artwork as a sibling immutable SQLite
 * database. This is an explicit seed/import operation, never a server runtime
 * fallback to the legacy JSON fixture.
 */
export function createDemoBaselineSnapshot(): string {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  const baselinePath = getDemoBaselinePath();
  const temporaryPath = `${baselinePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    sqlite.exec("PRAGMA wal_checkpoint(FULL)");
    sqlite.run("VACUUM INTO ?", [temporaryPath]);

    const baseline = new Database(temporaryPath, {
      readonly: true,
      strict: true,
    });
    try {
      const check = baseline
        .query<{ quick_check: string }, []>("PRAGMA quick_check")
        .get();
      if (check?.quick_check !== "ok") {
        throw new Error(
          `Demo baseline SQLite quick_check failed: ${check?.quick_check ?? "unknown"}`
        );
      }
    } finally {
      baseline.close(false);
    }
    chmodSync(temporaryPath, 0o444);
    renameSync(temporaryPath, baselinePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return baselinePath;
}

/** Restore every demo table from the immutable sibling SQLite baseline. */
export function restoreDemoBaselineSnapshot(): void {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  const baselinePath = getDemoBaselinePath();
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Demo SQLite baseline is missing at ${baselinePath}. Run bun run demo:download to build a fresh demo, or bun run demo:migrate-json for a legacy JSON migration.`
    );
  }

  sqlite.run("ATTACH DATABASE ? AS demo_baseline", [baselinePath]);
  try {
    const check = sqlite
      .query<{ quick_check: string }, []>("PRAGMA demo_baseline.quick_check")
      .get();
    if (check?.quick_check !== "ok") {
      throw new Error(
        `Demo baseline SQLite quick_check failed: ${check?.quick_check ?? "unknown"}`
      );
    }

    const tables = (schema: "main" | "demo_baseline") =>
      sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM ${schema}.sqlite_master
           WHERE type = 'table' AND name LIKE 'demo_%'
           ORDER BY name`
        )
        .all()
        .map((row) => row.name);
    const liveTables = tables("main");
    const baselineTables = tables("demo_baseline");
    if (JSON.stringify(liveTables) !== JSON.stringify(baselineTables)) {
      throw new Error(
        "Demo baseline schema does not match the current demo migrations. Run bun run demo:download to rebuild it, or bun run demo:migrate-json for a legacy JSON migration."
      );
    }

    sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      sqlite
        .transaction(() => {
          for (const table of [...liveTables].reverse()) {
            sqlite.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
          }
          for (const table of liveTables) {
            const identifier = quoteIdentifier(table);
            sqlite.exec(
              `INSERT INTO main.${identifier} SELECT * FROM demo_baseline.${identifier}`
            );
          }
          sqlite.exec(
            "DELETE FROM main.sqlite_sequence WHERE name LIKE 'demo_%'"
          );
          sqlite.exec(
            `INSERT INTO main.sqlite_sequence(name, seq)
           SELECT name, seq FROM demo_baseline.sqlite_sequence
           WHERE name LIKE 'demo_%'`
          );

          const violation = sqlite
            .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
            .get();
          if (violation) {
            throw new Error(
              "Demo baseline restore violated SQLite foreign keys"
            );
          }
        })
        .immediate();
    } finally {
      sqlite.exec("PRAGMA foreign_keys = ON");
    }
  } finally {
    sqlite.exec("DETACH DATABASE demo_baseline");
  }
}
