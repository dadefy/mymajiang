import type { PoolClient } from "pg";
import type { PostgresDatabase } from "./database.js";

export interface SqlStatement {
  sql: string;
  parameters: readonly unknown[];
}

/**
 * Serialises every database write issued by the server.
 *
 * Every Postgres repository shares a single queue so that writes are applied in the order the
 * domain services requested them, and so that one `flush()` drains all of them before an HTTP
 * response is sent. Plain statements go through the pool; `enqueueTransaction` claims one client
 * and wraps its statements in BEGIN/COMMIT so a multi-row change can never be applied partially.
 */
export class PostgresWriteQueue {
  private pending: Promise<{ error?: unknown }> = Promise.resolve({});

  constructor(private readonly database: PostgresDatabase) {}

  /** Each operation has its own result; flush callers share an immutable batch result. */
  private schedule(write: () => Promise<void>): Promise<void> {
    const previous = this.pending;
    const operation = previous.then(write);
    this.pending = Promise.all([
      previous,
      operation.then(() => ({}), (error: unknown) => ({ error })),
    ]).then(([before, result]) => "error" in before ? before : result);
    return operation;
  }

  /** Queues a single auto-committed statement. */
  enqueue(sql: string, parameters: readonly unknown[] = []): Promise<void> {
    return this.schedule(async () => {
      await this.database.pool.query(sql, [...parameters]);
    });
  }

  /** Queues statements that must commit or roll back together. */
  enqueueTransaction(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return Promise.resolve();
    return this.schedule(async () => {
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) {
          await client.query(statement.sql, [...statement.parameters]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /** Every waiter on the same batch observes the same failure. */
  async flush(): Promise<void> {
    const batch = this.pending;
    const result = await batch;
    if (this.pending === batch) this.pending = Promise.resolve({});
    if ("error" in result) throw result.error;
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection is already unusable; releasing it lets the pool discard it.
  }
}
