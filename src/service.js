import { z } from "zod";
import { one, audit } from "./db.js";
import { hash, secret } from "./crypto.js";
export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
export const id = z.uuid();
export const tags = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(30)
      .regex(/^[\p{L}\p{N} _-]+$/u),
  )
  .max(10)
  .default([]);
export const communityInput = z.object({
  guild_id: z.string().regex(/^\d{17,20}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default("id"),
  tags,
});
export const campaignInput = z
  .object({
    community_id: id,
    name: z.string().trim().min(2).max(100),
    limit: z.number().int().min(1).max(1000).default(100),
    tags,
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
  })
  .refine(
    (x) => new Date(x.ends_at) > new Date(x.starts_at),
    "End must follow start",
  );
export function service(db, crypt, discord, config) {
  async function session(kind, subject, token = null, seconds = 3600) {
    const raw = secret();
    await db.query(
      "INSERT INTO member_network.sessions(token_hash,kind,subject,credential,expires_at) VALUES ($1,$2,$3,$4,now()+($5 * interval '1 second'))",
      [
        hash(raw),
        kind,
        subject,
        token ? crypt.encrypt(token, subject) : null,
        seconds,
      ],
    );
    return raw;
  }
  async function getSession(raw, kind) {
    if (!raw) return null;
    return one(
      db,
      "SELECT * FROM member_network.sessions WHERE token_hash=$1 AND kind=$2 AND expires_at>now()",
      [hash(raw), kind],
    );
  }
  async function revokeConnection(memberId, actor) {
    // Preserve encrypted tokens only until the revocation worker succeeds, never expose them.
    await db.tx(async (tx) => {
      const m = await one(
        tx,
        "SELECT id FROM member_network.members WHERE id=$1 FOR UPDATE",
        [memberId],
      );
      if (!m) throw new Problem(404, "Anggota tidak ditemukan");
      await tx.query(
        "UPDATE member_network.members SET connection_status='revoked',updated_at=now() WHERE id=$1",
        [memberId],
      );
      await tx.query(
        "UPDATE member_network.consents SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL",
        [memberId],
      );
      await tx.query(
        "UPDATE member_network.jobs SET status='cancelled',updated_at=now() WHERE member_id=$1 AND status IN ('queued','retry','processing')",
        [memberId],
      );
      await tx.query(
        "UPDATE member_network.connections SET revoke_pending=true WHERE member_id=$1",
        [memberId],
      );
      await tx.query(
        "DELETE FROM member_network.sessions WHERE kind='member' AND subject=$1",
        [memberId],
      );
      await audit(tx, actor, "member.disconnect", memberId);
    });
  }
  return {
    session,
    getSession,
    revokeConnection,
    async beginOAuth(browser) {
      const raw = secret();
      await db.query(
        "INSERT INTO member_network.oauth_states(state_hash,browser_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [hash(raw), hash(browser)],
      );
      return discord.authorize(raw);
    },
    async callback(state, browser, code) {
      const consumed = await one(
        db,
        "DELETE FROM member_network.oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING state_hash",
        [hash(state), hash(browser)],
      );
      if (!consumed)
        throw new Problem(400, "Sesi OAuth tidak valid atau kedaluwarsa");
      const token = await discord.exchange(code);
      if (
        !["identify", "guilds.join"].every((s) =>
          token.scope?.split(" ").includes(s),
        )
      )
        throw new Problem(400, "Izin Discord tidak lengkap");
      const profile = z
        .object({
          id: z.string().regex(/^\d{17,20}$/),
          username: z.string().min(1).max(100),
        })
        .parse(await discord.profile(token.access_token));
      const member = await db.tx(async (tx) => {
        const m = await one(
          tx,
          "INSERT INTO member_network.members(discord_id,username) VALUES ($1,$2) ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username,connection_status='connected',updated_at=now() RETURNING id",
          [profile.id, profile.username],
        );
        await tx.query(
          "INSERT INTO member_network.connections(member_id,encrypted_tokens,expires_at) VALUES ($1,$2,now()+($3 * interval '1 second')) ON CONFLICT(member_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,revoke_pending=false",
          [m.id, crypt.encrypt(token, m.id), token.expires_in],
        );
        await audit(tx, m.id, "member.connect", m.id);
        return m;
      });
      return session("member", member.id, null, 86400);
    },
    async consent(memberId, communityId) {
      return db.tx(async (tx) => {
        const m = await one(
          tx,
          "SELECT id FROM member_network.members WHERE id=$1 AND active=true AND connection_status='connected' FOR UPDATE",
          [memberId],
        );
        const c = await one(
          tx,
          "SELECT id FROM member_network.communities WHERE id=$1 AND status='approved'",
          [communityId],
        );
        if (!m || !c)
          throw new Problem(409, "Akun atau komunitas tidak tersedia");
        // Each renewed consent receives a new version ID, old jobs never inherit a new permission.
        await tx.query(
          "UPDATE member_network.consents SET revoked_at=now() WHERE member_id=$1 AND community_id=$2 AND revoked_at IS NULL",
          [memberId, communityId],
        );
        await tx.query(
          "UPDATE member_network.jobs SET status='cancelled' WHERE member_id=$1 AND community_id=$2 AND status IN ('queued','retry')",
          [memberId, communityId],
        );
        const r = await one(
          tx,
          "INSERT INTO member_network.consents(member_id,community_id,version,expires_at) VALUES ($1,$2,'per-community-v1',now()+interval '30 days') RETURNING id,expires_at",
          [memberId, communityId],
        );
        await audit(tx, memberId, "consent.grant", communityId);
        return r;
      });
    },
    async removeConsent(memberId, communityId) {
      await db.tx(async (tx) => {
        await tx.query(
          "SELECT id FROM member_network.members WHERE id=$1 FOR UPDATE",
          [memberId],
        );
        await tx.query(
          "UPDATE member_network.consents SET revoked_at=now() WHERE member_id=$1 AND community_id=$2 AND revoked_at IS NULL",
          [memberId, communityId],
        );
        await tx.query(
          "UPDATE member_network.jobs SET status='cancelled',updated_at=now() WHERE member_id=$1 AND community_id=$2 AND status IN ('queued','retry','processing')",
          [memberId, communityId],
        );
        await audit(tx, memberId, "consent.revoke", communityId);
      });
    },
    async startCampaign(campaignId, actor) {
      return db.tx(async (tx) => {
        const c = await one(
          tx,
          "SELECT * FROM member_network.campaigns WHERE id=$1 FOR UPDATE",
          [campaignId],
        );
        if (!c) throw new Problem(404, "Campaign tidak ditemukan");
        if (["completed", "cancelled"].includes(c.status))
          throw new Problem(409, "Campaign sudah ditutup");
        const community = await one(
          tx,
          "SELECT id FROM member_network.communities WHERE id=$1 AND status='approved'",
          [c.community_id],
        );
        if (!community || new Date(c.ends_at) <= new Date())
          throw new Problem(409, "Komunitas atau jadwal tidak tersedia");
        await tx.query(
          "UPDATE member_network.campaigns SET status='running' WHERE id=$1",
          [campaignId],
        );
        const result = await tx.query(
          `INSERT INTO member_network.jobs(campaign_id,community_id,member_id,consent_id,next_attempt_at)
          SELECT $1,$2,m.id,s.id,GREATEST(now(),$3::timestamptz)
          FROM member_network.members m JOIN member_network.consents s ON s.member_id=m.id
          WHERE s.community_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND m.active AND m.connection_status='connected' AND (cardinality($4::text[])=0 OR m.interests && $4::text[])
          AND NOT EXISTS(SELECT 1 FROM member_network.jobs j WHERE j.consent_id=s.id OR (j.campaign_id=$1 AND j.member_id=m.id))
          ORDER BY s.created_at,m.id LIMIT GREATEST(0,$5-(SELECT count(*)::int FROM member_network.jobs WHERE campaign_id=$1))
          ON CONFLICT(campaign_id,member_id) DO NOTHING RETURNING id`,
          [campaignId, c.community_id, c.starts_at, c.tags, c.member_limit],
        );
        await audit(tx, actor, "campaign.start", campaignId, {
          queued: result.rows.length,
        });
        return { queued: result.rows.length };
      });
    },
    async createCommunity(input, actor) {
      // A bot-visible guild proves installation. CMS administrators moderate registration.
      const guild = await discord.guild(input.guild_id);
      if (guild.id !== input.guild_id)
        throw new Problem(409, "Bot belum terpasang di server ini");
      return db.tx(async (tx) => {
        const r = await one(
          tx,
          "INSERT INTO member_network.communities(guild_id,name,description,language,tags) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [
            input.guild_id,
            input.name,
            input.description,
            input.language,
            input.tags,
          ],
        );
        await audit(tx, actor, "community.create", r.id);
        return r;
      });
    },
    async createCampaign(input, actor) {
      return db.tx(async (tx) => {
        const c = await one(
          tx,
          "SELECT id FROM member_network.communities WHERE id=$1 AND status='approved'",
          [input.community_id],
        );
        if (!c) throw new Problem(409, "Komunitas belum disetujui");
        const r = await one(
          tx,
          "INSERT INTO member_network.campaigns(community_id,name,member_limit,tags,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            input.community_id,
            input.name,
            input.limit,
            input.tags,
            input.starts_at,
            input.ends_at,
          ],
        );
        await audit(tx, actor, "campaign.create", r.id);
        return r;
      });
    },
  };
}
