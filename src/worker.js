import { randomUUID } from "node:crypto";
import { one, audit } from "./db.js";
export function worker(db, crypt, discord, config) {
  let wakeRequested = false;
  let busy = false,
    timer,
    stopped = true;
  async function revokeOne() {
    return db.tx(async (tx) => {
      const c = await one(
        tx,
        `SELECT c.* FROM member_network.connections c JOIN member_network.members m ON m.id=c.member_id
        WHERE c.revoke_pending AND c.encrypted_tokens IS NOT NULL AND c.revoke_after<=now()
        ORDER BY c.revoke_after LIMIT 1 FOR UPDATE OF m,c SKIP LOCKED`,
      );
      if (!c) return false;
      try {
        const token = crypt.decrypt(c.encrypted_tokens, c.member_id);
        await discord.revoke(token.access_token);
        await tx.query(
          "UPDATE member_network.connections SET encrypted_tokens=NULL,revoke_pending=false WHERE member_id=$1",
          [c.member_id],
        );
        await tx.query(
          "UPDATE member_network.members SET discord_id=NULL,username='Akun dihapus',interests='{}',active=false,deleted_at=now() WHERE id=$1 AND delete_requested_at IS NOT NULL",
          [c.member_id],
        );
        await audit(tx, "worker", "oauth.revoked", c.member_id);
      } catch {
        await tx.query(
          "UPDATE member_network.connections SET revoke_after=now()+interval '15 minutes' WHERE member_id=$1",
          [c.member_id],
        );
      }
      return true;
    });
  }
  async function runOne() {
    if (!config.AUTO_JOIN_ENABLED) return false;
    const lease = randomUUID();
    // A crashed in-flight request is ambiguous. Never blindly repeat it.
    await db.query(
      "UPDATE member_network.jobs SET status='unknown',error_code='LEASE_EXPIRED',updated_at=now() WHERE status='processing' AND lease_until<now()",
    );
    const job = await one(
      db,
      `UPDATE member_network.jobs SET status='processing',lease_token=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT j.id FROM member_network.jobs j JOIN member_network.campaigns c ON c.id=j.campaign_id
      WHERE j.status IN ('queued','retry') AND j.next_attempt_at<=now() AND c.status='running' AND c.starts_at<=now() AND c.ends_at>now()
      ORDER BY j.next_attempt_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED) RETURNING *`,
      [lease],
    );
    if (!job) return false;
    await db.tx(async (tx) => {
      // Lock member first consistently with revocation, then check the exact consent version.
      const m = await one(
        tx,
        "SELECT * FROM member_network.members WHERE id=$1 FOR UPDATE",
        [job.member_id],
      );
      const j = await one(
        tx,
        "SELECT * FROM member_network.jobs WHERE id=$1 AND status='processing' AND lease_token=$2 FOR UPDATE",
        [job.id, lease],
      );
      if (!j) return;
      const consent = await one(
        tx,
        "SELECT id FROM member_network.consents WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()",
        [j.consent_id],
      );
      const community = await one(
        tx,
        "SELECT * FROM member_network.communities WHERE id=$1 AND status='approved'",
        [j.community_id],
      );
      const campaign = await one(
        tx,
        "SELECT id FROM member_network.campaigns WHERE id=$1 AND status='running' AND starts_at<=now() AND ends_at>now() FOR UPDATE",
        [j.campaign_id],
      );
      let status = "cancelled",
        error = null;
      if (
        m?.active &&
        m.connection_status === "connected" &&
        consent &&
        community &&
        campaign &&
        config.AUTO_JOIN_ENABLED
      ) {
        const c = await one(
          tx,
          "SELECT * FROM member_network.connections WHERE member_id=$1 AND NOT revoke_pending FOR UPDATE",
          [m.id],
        );
        if (c?.encrypted_tokens) {
          let sending = false;
          let phase = "refresh";
          try {
            let tokens = crypt.decrypt(c.encrypted_tokens, m.id);
            if (new Date(c.expires_at).getTime() < Date.now() + 60000) {
              tokens = await discord.refresh(tokens.refresh_token);
              if (!tokens.scope?.split(" ").includes("guilds.join"))
                throw Object.assign(new Error("scope missing"), {
                  status: 401,
                });
              await tx.query(
                "UPDATE member_network.connections SET encrypted_tokens=$2,expires_at=now()+($3 * interval '1 second') WHERE member_id=$1",
                [m.id, crypt.encrypt(tokens, m.id), tokens.expires_in],
              );
            }
            phase = "guild";
            await discord.guild(community.guild_id);
            phase = "join";
            sending = true;
            status = await discord.join(
              community.guild_id,
              m.discord_id,
              tokens.access_token,
            );
          } catch (err) {
            error = err.status
              ? `DISCORD_${err.status}`
              : "UPSTREAM_UNAVAILABLE";
            if (err.status === 429) {
              status = j.attempts < 5 ? "retry" : "failed";
              const delay = Math.min(86400, Math.max(1, err.retryAfter || 30));
              await tx.query(
                "UPDATE member_network.jobs SET next_attempt_at=now()+($2 * interval '1 second') WHERE id=$1",
                [j.id, delay],
              );
              // Respect Discord's rate limit globally in this worker before another request.
              await tx.query(
                "INSERT INTO member_network.runtime(key,value) VALUES ('discord_backoff',now()+($1 * interval '1 second')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [delay],
              );
            } else if (
              (err.status === 401 && phase !== "guild") ||
              (phase === "refresh" && err.status === 400)
            ) {
              status = "failed";
              await tx.query(
                "UPDATE member_network.members SET connection_status='expired' WHERE id=$1",
                [m.id],
              );
            } else
              status =
                sending && (!err.status || err.status >= 500)
                  ? "unknown"
                  : "failed";
          }
        } else error = "NO_CONNECTION";
      }
      await tx.query(
        "UPDATE member_network.jobs SET status=$2,error_code=$3,lease_until=NULL,updated_at=now() WHERE id=$1",
        [j.id, status, error],
      );
      await audit(tx, "worker", "join.result", j.id, { status });
    });
    return true;
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    let wait = 900000;
    try {
      const backoff = await one(
        db,
        "SELECT value FROM member_network.runtime WHERE key='discord_backoff' AND value>now()",
      );
      if (backoff)
        wait = Math.max(1000, new Date(backoff.value).getTime() - Date.now());
      else {
        const revoked = await revokeOne();
        if (revoked) wait = 1500;
        if (await runOne()) wait = 1500;
        else {
          const next = await one(
            db,
            `SELECT min(GREATEST(j.next_attempt_at,c.starts_at)) AS due FROM member_network.jobs j JOIN member_network.campaigns c ON c.id=j.campaign_id
          WHERE j.status IN ('queued','retry') AND c.status='running' AND c.ends_at>now()`,
          );
          if (next?.due && config.AUTO_JOIN_ENABLED)
            wait = Math.min(
              wait,
              Math.max(1500, new Date(next.due).getTime() - Date.now()),
            );
        }
      }
    } catch {
      // No token, raw upstream error or SQL text is logged.
      wait = 30000;
    } finally {
      busy = false;
      if (wakeRequested) {
        wait = 10;
        wakeRequested = false;
      }
      if (!stopped) {
        clearTimeout(timer);
        timer = setTimeout(tick, wait);
        timer.unref();
      }
    }
  }
  return {
    runOne,
    revokeOne,
    start() {
      stopped = false;
      return tick();
    },
    wake() {
      if (stopped) return;
      if (busy) {
        wakeRequested = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(tick, 10);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      while (busy) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
