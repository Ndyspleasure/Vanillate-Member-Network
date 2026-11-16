import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { one } from "./db.js";
export const versions = [
  ["initial", "schema.sql"],
  ["002_member_retention", "upgrades/002_member_retention.sql"],
];
export async function migrate(db) {
  return db.tx(async (tx) => {
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
    for (const [version, path] of versions) {
      const sql = await readFile(
        new URL(`../db/${path}`, import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await one(
        tx,
        "SELECT checksum FROM member_network.schema_versions WHERE version=$1",
        [version],
      );
      if (prior && prior.checksum !== checksum)
        throw new Error("SCHEMA_CHECKSUM_MISMATCH");
      if (!prior) {
        await tx.query(sql);
        await tx.query(
          "INSERT INTO member_network.schema_versions(version,checksum) VALUES ($1,$2)",
          [version, checksum],
        );
      }
    }
    return versions.length;
  });
}
