import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { NotFoundError } from "@/utils/errors";
import type { BackupInfo, ExportData } from "./backup.types";

const BACKUP_RESOURCE_KIND = "demo-backup";
const BACKUP_SEQUENCE_KEY = "backup_sequence";

type DemoRow = Record<string, unknown>;

interface DemoSnapshot {
  tables: Record<string, DemoRow[]>;
}

interface StoredDemoBackup {
  info: BackupInfo;
  snapshot: DemoSnapshot;
}

interface ResourceRow {
  id: string;
  payload_json: string;
}

function quoteIdentifier(identifier: string): string {
  if (!/^demo_[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe demo table identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * Backup operations whose complete boundary is the isolated demo SQLite file.
 * No method reads the production database or the application's backup folder.
 */
export class BackupDemoService {
  private tableNames(): string[] {
    initializeDemoDatabase();
    return getDemoSqlite()
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'demo_%'
         ORDER BY name`
      )
      .all()
      .map((row) => row.name);
  }

  private snapshot(): DemoSnapshot {
    const sqlite = getDemoSqlite();
    const tables: Record<string, DemoRow[]> = {};
    for (const table of this.tableNames()) {
      const rows = sqlite
        .query<DemoRow, []>(`SELECT * FROM ${quoteIdentifier(table)}`)
        .all();
      tables[table] =
        table === "demo_resources"
          ? rows.filter((row) => row.kind !== BACKUP_RESOURCE_KIND)
          : rows;
    }
    return { tables };
  }

  private storedBackups(): StoredDemoBackup[] {
    initializeDemoDatabase();
    return getDemoSqlite()
      .query<ResourceRow, [string]>(
        `SELECT id, payload_json FROM demo_resources
         WHERE kind = ? ORDER BY created_at DESC, id DESC`
      )
      .all(BACKUP_RESOURCE_KIND)
      .map((row) => JSON.parse(row.payload_json) as StoredDemoBackup);
  }

  private backupSequence(): number {
    return Number(
      getDemoSqlite()
        .query<
          { value: string },
          [string]
        >("SELECT value FROM demo_meta WHERE key = ?")
        .get(BACKUP_SEQUENCE_KEY)?.value ?? 0
    );
  }

  private writeBackupSequence(sequence: number): void {
    const updatedAt = new Date().toISOString();
    getDemoSqlite().run(
      `INSERT INTO demo_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [BACKUP_SEQUENCE_KEY, String(sequence), updatedAt]
    );
  }

  private nextBackupSequence(): number {
    const existingMaximum = this.storedBackups().reduce((maximum, backup) => {
      const match = /^demo-backup-(\d+)\.json$/.exec(backup.info.filename);
      return Math.max(maximum, Number(match?.[1] ?? 0));
    }, 0);
    const next = Math.max(this.backupSequence(), existingMaximum) + 1;
    this.writeBackupSequence(next);
    return next;
  }

  async createBackup(): Promise<BackupInfo> {
    return withDemoTransaction(() => {
      const snapshot = this.snapshot();
      const sequence = this.nextBackupSequence();
      const filename = `demo-backup-${String(sequence).padStart(6, "0")}.json`;
      const createdAt = new Date().toISOString();
      const sizeBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      const info: BackupInfo = {
        filename,
        path: `demo://backups/${filename}`,
        sizeBytes,
        createdAt,
      };

      getDemoSqlite().run(
        `INSERT INTO demo_resources
         (kind, id, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          BACKUP_RESOURCE_KIND,
          filename,
          JSON.stringify({ info, snapshot } satisfies StoredDemoBackup),
          createdAt,
          createdAt,
        ]
      );
      return info;
    });
  }

  listBackups(): BackupInfo[] {
    return this.storedBackups().map((backup) => backup.info);
  }

  async restoreBackup(filename: string): Promise<void> {
    const backup = this.storedBackups().find(
      (candidate) => candidate.info.filename === filename
    );
    if (!backup) throw new NotFoundError(`Backup not found: ${filename}`);

    const sqlite = getDemoSqlite();
    const currentTables = new Set(this.tableNames());
    const preservedSequence = this.backupSequence();
    const preservedBackupRows = sqlite
      .query<
        DemoRow,
        [string]
      >("SELECT * FROM demo_resources WHERE kind = ? ORDER BY id")
      .all(BACKUP_RESOURCE_KIND);

    sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      sqlite
        .transaction(() => {
          for (const table of currentTables) {
            sqlite.run(`DELETE FROM ${quoteIdentifier(table)}`);
          }

          for (const [table, rows] of Object.entries(backup.snapshot.tables)) {
            if (!currentTables.has(table)) continue;
            for (const row of rows) this.insertRow(table, row);
          }
          for (const row of preservedBackupRows) {
            this.insertRow("demo_resources", row);
          }
          this.writeBackupSequence(
            Math.max(preservedSequence, this.backupSequence())
          );

          const violation = sqlite
            .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
            .get();
          if (violation) {
            throw new Error("Demo backup restore violated SQLite foreign keys");
          }
        })
        .immediate();
    } finally {
      sqlite.exec("PRAGMA foreign_keys = ON");
    }
  }

  deleteBackup(filename: string): void {
    initializeDemoDatabase();
    const result = getDemoSqlite().run(
      "DELETE FROM demo_resources WHERE kind = ? AND id = ?",
      [BACKUP_RESOURCE_KIND, filename]
    );
    if (result.changes === 0) {
      throw new NotFoundError(`Backup not found: ${filename}`);
    }
  }

  async exportToJson(): Promise<ExportData> {
    const snapshot = this.snapshot();
    const table = (name: string) => snapshot.tables[name] ?? [];
    return {
      exportedAt: new Date().toISOString(),
      version: "0.1.0-demo-sqlite",
      tables: {
        users: [],
        directories: [],
        videos: table("demo_videos"),
        creators: table("demo_creators"),
        tags: table("demo_tags"),
        ratings: table("demo_ratings"),
        playlists: table("demo_playlists"),
        favorites: table("demo_favorites"),
        creator_favorites: table("demo_creator_favorites"),
        bookmarks: table("demo_bookmarks"),
      },
    };
  }

  private insertRow(table: string, row: DemoRow): void {
    const columns = Object.keys(row);
    if (columns.length === 0) return;
    const quotedColumns = columns.map((column) => {
      if (!/^[a-z][a-z0-9_]*$/.test(column)) {
        throw new Error(`Unsafe demo column identifier: ${column}`);
      }
      return `"${column}"`;
    });
    getDemoSqlite().run(
      `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => row[column] as never)
    );
  }
}

export const backupDemoService = new BackupDemoService();
