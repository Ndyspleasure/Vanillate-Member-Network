import { database } from "../src/db.js";
import { maintenance } from "../src/maintenance.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = database(process.env.DATABASE_URL);
try {
  await maintenance(db);
  console.info("Retention cleanup completed");
} catch {
  console.error("Retention cleanup failed");
  process.exitCode = 1;
} finally {
  await db.close();
}
