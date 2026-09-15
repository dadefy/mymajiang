import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type Pool as PgPool } from "pg";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const MIGRATION_LOCK_ID = 9_132_026;

export interface DatabaseOptions {
  connectionString: string;
  ssl?: boolean;
  maximumConnections?: number;
}

/**
 * Migration versions in the order they must run, derived from the `.sql` filenames under
 * `db/migrations`. The first file is `001_initial`, so databases created before that directory
 * existed keep their recorded version and are not replayed.
 */
export async function migrationVersions(directory: string = MIGRATIONS_DIRECTORY): Promise<string[]> {
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -4))
    .sort();
}

export class PostgresDatabase {
  readonly pool: PgPool;

  constructor(options: DatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maximumConnections ?? 10,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /**
   * Applies every migration that has not run yet, in filename order, in a single transaction
   * guarded by an advisory lock so concurrent starts cannot apply the same file twice.
   *
   * New database changes must be added as a new file under `db/migrations`; never edit a migration
   * that has already been applied to a live database.
   */
  async migrate(): Promise<void> {
    const versions = await migrationVersions();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(100) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
      const alreadyApplied = new Set(applied.rows.map((row) => row.version));
      for (const version of versions) {
        if (alreadyApplied.has(version)) continue;
        await client.query(await readFile(join(MIGRATIONS_DIRECTORY, `${version}.sql`), "utf-8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
