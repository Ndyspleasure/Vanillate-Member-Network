import { database } from "../src/db.js";
import { migrate } from "../src/migrations.js";
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
const db = database(url);
try {
  await migrate(db);
  console.info("Member Network migrations verified");
} catch {
  console.error(
    "Migration failed. Check database access and immutable schema checksums. Transaction rolled back.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
