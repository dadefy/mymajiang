import { PostgresDatabase } from "./database.js";
import { loadEnvironment } from "./load-environment.js";

loadEnvironment();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const database = new PostgresDatabase({
  connectionString,
  ssl: process.env.DATABASE_SSL === "true",
});

try {
  await database.migrate();
  process.stdout.write("Database migrations completed\n");
} finally {
  await database.close();
}
