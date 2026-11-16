import { audit } from "./db.js";
export async function maintenance(db) {
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
    await tx.query(
      "DELETE FROM member_network.jobs WHERE updated_at<now()-interval '90 days' AND status NOT IN ('queued','processing','retry')",
    );
    await tx.query(
      "DELETE FROM member_network.consents s WHERE s.expires_at<now()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM member_network.jobs j WHERE j.consent_id=s.id)",
    );
    await tx.query(`UPDATE member_network.members m SET discord_id=NULL,username='Akun dihapus',interests='{}',active=false,deleted_at=now()
      WHERE m.deleted_at IS NULL AND (m.delete_requested_at IS NOT NULL OR (m.connection_status='revoked' AND m.updated_at<now()-interval '90 days'))
      AND NOT EXISTS(SELECT 1 FROM member_network.connections c WHERE c.member_id=m.id AND c.encrypted_tokens IS NOT NULL)`);
    await audit(tx, "maintenance", "retention.cleanup");
  });
}
