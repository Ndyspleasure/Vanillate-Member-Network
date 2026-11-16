import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { database, one } from "../src/db.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = database(process.env.DATABASE_URL);
try {
  const sql = await readFile(
    new URL("../db/schema.sql", import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256").update(sql).digest("hex");
  await db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(18662,1)");
    await tx.query("CREATE SCHEMA IF NOT EXISTS member_network");
    await tx.query("REVOKE ALL ON SCHEMA member_network FROM PUBLIC");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS member_network.schema_versions (version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await tx.query(
      "ALTER TABLE member_network.schema_versions ENABLE ROW LEVEL SECURITY",
    );
    await tx.query("REVOKE ALL ON member_network.schema_versions FROM PUBLIC");
    const existing = await one(
      tx,
      "SELECT checksum FROM member_network.schema_versions WHERE version='initial'",
    );
    if (existing && existing.checksum !== checksum)
      throw new Error(
        "Applied schema checksum mismatch. Create an additive upgrade instead of editing applied SQL.",
      );
    if (!existing) {
      await tx.query(sql);
      await tx.query(
        "INSERT INTO member_network.schema_versions(version,checksum) VALUES ('initial',$1)",
        [checksum],
      );
    }
  });
  console.info("Member Network schema verified");
} catch {
  console.error(
    "Migration failed. Check database access and schema checksum. No partial changes were committed.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
