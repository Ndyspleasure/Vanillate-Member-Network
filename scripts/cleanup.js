import { database, audit } from "../src/db.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = database(process.env.DATABASE_URL);
try {
  await db.tx(async (tx) => {
    await tx.query(
      "DELETE FROM member_network.oauth_states WHERE expires_at<now()",
    );
    await tx.query(
      "DELETE FROM member_network.sessions WHERE expires_at<now()",
    );
    await tx.query(
      "DELETE FROM member_network.audit WHERE created_at<now()-interval '90 days'",
    );
    await tx.query(
      "SELECT id FROM member_network.campaigns WHERE ends_at<=now() AND status IN ('draft','running','paused') FOR UPDATE",
    );
    await tx.query(
      "UPDATE member_network.campaigns SET status='completed' WHERE ends_at<=now() AND status IN ('draft','running','paused')",
    );
    await tx.query(
      "UPDATE member_network.jobs SET status='cancelled',updated_at=now() WHERE status IN ('queued','retry') AND campaign_id IN (SELECT id FROM member_network.campaigns WHERE status IN ('completed','cancelled'))",
    );
    await audit(tx, "maintenance", "retention.cleanup");
  });
  console.info("Retention cleanup completed");
} catch {
  console.error("Retention cleanup failed");
  process.exitCode = 1;
} finally {
  await db.close();
}
