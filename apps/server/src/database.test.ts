import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrationVersions } from "./database.js";

describe("migrations", () => {
  const scratchDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function scratchDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mianyang-migrations-"));
    scratchDirectories.push(directory);
    return directory;
  }

  it("orders migrations by filename, not by the order they were written", async () => {
    const directory = await scratchDirectory();
    for (const name of ["010_ten.sql", "002_two.sql", "001_initial.sql"]) {
      await writeFile(join(directory, name), "SELECT 1;");
    }

    expect(await migrationVersions(directory)).toEqual(["001_initial", "002_two", "010_ten"]);
  });

  it("ignores files that are not migrations", async () => {
    const directory = await scratchDirectory();
    await writeFile(join(directory, "001_initial.sql"), "SELECT 1;");
    await writeFile(join(directory, "README.md"), "not a migration");
    await writeFile(join(directory, "002_note.sql.bak"), "not a migration either");

    expect(await migrationVersions(directory)).toEqual(["001_initial"]);
  });

  it("keeps 001_initial as the first shipped migration so existing databases stay in sync", async () => {
    const versions = await migrationVersions();

    expect(versions[0]).toBe("001_initial");
    expect(versions.length).toBeGreaterThan(1);
    expect([...versions].sort()).toEqual(versions);
  });
});
