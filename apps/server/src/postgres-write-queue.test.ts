import { describe, expect, it, vi } from "vitest";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import type { PostgresDatabase } from "./database.js";

function queueWith(query: () => Promise<unknown>) {
  return new PostgresWriteQueue({ pool: { query } } as unknown as PostgresDatabase);
}

describe("write queue failure delivery", () => {
  it("reports the same failed batch to every concurrent waiter and permits a clean retry", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ rows: [] });
    const queue = queueWith(query);
    queue.enqueue("first");
    const results = await Promise.allSettled([queue.flush(), queue.flush(), queue.flush()]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    await queue.enqueue("retry");
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it("keeps writes appended while an earlier flush is waiting", async () => {
    let finish!: () => void;
    const query = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("second failed"));
    const queue = queueWith(query);
    queue.enqueue("first");
    const first = queue.flush();
    queue.enqueue("second");
    const second = queue.flush();
    const all = Promise.allSettled([first, second]);
    await Promise.resolve();
    finish();
    expect((await all).map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  });
});
