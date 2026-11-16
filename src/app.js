import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, secret } from "./crypto.js";
import { one, audit } from "./db.js";
import {
  service,
  Problem,
  id,
  tags,
  communityInput,
  campaignInput,
} from "./service.js";
const uuidParam = (request) => id.parse(request.params.id);
const page = (query) =>
  z
    .object({
      after: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(query);
export async function buildApp({
  db,
  crypt,
  discord,
  identity,
  config,
  worker,
}) {
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: false });
  const svc = service(db, crypt, discord, config);
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  const origin = new URL(config.APP_BASE_URL).origin;
  const origins = new Set([
    origin,
    ...(config.CMS_ORIGIN ? [new URL(config.CMS_ORIGIN).origin] : []),
  ]);
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
  };
  function setSession(reply, name, value, maxAge) {
    reply.setCookie(name, value, { ...cookieOptions, maxAge });
  }
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    const o = req.headers.origin;
    if (o && origins.has(o))
      reply.headers({
        "Access-Control-Allow-Origin": o,
        Vary: "Origin",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      });
    if (req.method === "OPTIONS")
      return reply.code(origins.has(o) ? 204 : 403).send();
    if (
      ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
      (!o || !origins.has(o))
    )
      throw new Problem(403, "Origin tidak diizinkan");
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError || err.validation)
      return reply
        .code(400)
        .send({ error: "Input tidak valid", request_id: req.id });
    if (err.code === "23505")
      return reply
        .code(409)
        .send({ error: "Data sudah terdaftar", request_id: req.id });
    if (err.code === "23503")
      return reply
        .code(409)
        .send({ error: "Data terkait tidak tersedia", request_id: req.id });
    const status = err.statusCode || (err.status === 429 ? 503 : 500);
    reply
      .code(status)
      .send({
        error:
          status < 500
            ? err.message
            : "Layanan belum tersedia. Coba lagi nanti.",
        request_id: req.id,
      });
  });
  async function admin(req, write = false, pii = false) {
    let token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) {
      const s = await svc.getSession(req.cookies.mn_admin, "admin");
      if (s?.credential) token = crypt.decrypt(s.credential, s.subject);
    }
    if (!token) throw new Problem(401, "Silakan masuk sebagai admin");
    let user;
    try {
      user = await identity.user(token);
    } catch {
      throw new Problem(401, "Sesi admin kedaluwarsa");
    }
    const role = config.ADMIN_USER_IDS.includes(user.id)
      ? "admin"
      : config.VIEWER_USER_IDS.includes(user.id)
        ? "viewer"
        : null;
    if (!role || ((write || pii) && role !== "admin"))
      throw new Problem(403, "Akses tidak diizinkan");
    return { id: user.id, role };
  }
  async function member(req) {
    const s = await svc.getSession(req.cookies.mn_member, "member");
    if (!s) throw new Problem(401, "Hubungkan akun Discord terlebih dahulu");
    const m = await one(
      db,
      "SELECT id,discord_id,username,interests,active,connection_status FROM member_network.members WHERE id=$1 AND connection_status IN ('connected','expired')",
      [s.subject],
    );
    if (!m) throw new Problem(401, "Koneksi Discord telah dicabut");
    return m;
  }
  app.get("/health/live", async () => ({ ok: true }));
  app.get("/health/ready", async () => {
    await db.query("SELECT 1 FROM member_network.members LIMIT 1");
    return { ok: true };
  });
  app.post(
    "/auth/admin/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(1024),
        })
        .parse(req.body);
      let result, user;
      try {
        result = await identity.login(b.email, b.password);
        user = await identity.user(result.access_token);
      } catch {
        throw new Problem(401, "Email atau kata sandi tidak sesuai");
      }
      if (
        !config.ADMIN_USER_IDS.includes(user.id) &&
        !config.VIEWER_USER_IDS.includes(user.id)
      )
        throw new Problem(403, "Akun belum diberi akses Member Network");
      const ttl = Math.min(3600, Number(result.expires_in) || 3600);
      setSession(
        reply,
        "mn_admin",
        await svc.session("admin", user.id, result.access_token, ttl),
        ttl,
      );
      return { ok: true };
    },
  );
  app.post("/auth/logout", async (req, reply) => {
    for (const name of ["mn_admin", "mn_member"]) {
      if (req.cookies[name])
        await db.query(
          "DELETE FROM member_network.sessions WHERE token_hash=$1",
          [hash(req.cookies[name])],
        );
      reply.clearCookie(name, cookieOptions);
    }
    return { ok: true };
  });
  app.get("/api/admin/session", async (req) => admin(req));
  app.get(
    "/auth/discord/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const browser = secret();
      setSession(reply, "mn_oauth", browser, 600);
      return reply.redirect(await svc.beginOAuth(browser));
    },
  );
  app.get("/auth/discord/callback", async (req, reply) => {
    const b = z
      .object({
        state: z.string().min(20).max(200),
        code: z.string().min(1).max(2048),
      })
      .safeParse(req.query);
    const browser = req.cookies.mn_oauth;
    reply.clearCookie("mn_oauth", cookieOptions);
    if (!b.success || !browser) return reply.redirect("/?oauth=failed");
    try {
      setSession(
        reply,
        "mn_member",
        await svc.callback(b.data.state, browser, b.data.code),
        86400,
      );
      return reply.redirect("/?oauth=connected");
    } catch {
      return reply.redirect("/?oauth=failed");
    }
  });
  app.get("/api/me", async (req) => {
    const m = await member(req);
    const consents = (
      await db.query(
        "SELECT community_id,expires_at FROM member_network.consents WHERE member_id=$1 AND revoked_at IS NULL AND expires_at>now()",
        [m.id],
      )
    ).rows;
    return { ...m, consents };
  });
  app.patch("/api/me/interests", async (req) => {
    const m = await member(req);
    const b = z.object({ interests: tags }).parse(req.body);
    await db.tx(async (tx) => {
      await tx.query(
        "UPDATE member_network.members SET interests=$2 WHERE id=$1",
        [m.id, b.interests],
      );
      await audit(tx, m.id, "member.interests", m.id);
    });
    return { ok: true };
  });
  app.post("/api/me/consents/:id", async (req) => {
    const m = await member(req);
    return svc.consent(m.id, uuidParam(req));
  });
  app.delete("/api/me/consents/:id", async (req) => {
    const m = await member(req);
    await svc.removeConsent(m.id, uuidParam(req));
    worker.wake();
    return { ok: true };
  });
  app.post("/api/me/disconnect", async (req, reply) => {
    const m = await member(req);
    await svc.revokeConnection(m.id, m.id);
    worker.wake();
    reply.clearCookie("mn_member", cookieOptions);
    return { ok: true };
  });
  app.get("/api/me/activity", async (req) => {
    const m = await member(req);
    return (
      await db.query(
        "SELECT j.id,j.status,j.created_at,j.updated_at,c.name FROM member_network.jobs j JOIN member_network.communities c ON c.id=j.community_id WHERE j.member_id=$1 ORDER BY j.created_at DESC LIMIT 50",
        [m.id],
      )
    ).rows;
  });
  app.get("/api/catalog", async (req) => {
    const b = z
      .object({
        language: z
          .string()
          .regex(/^[a-z]{2}$/)
          .optional(),
        tag: z.string().max(30).optional(),
        ...{
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        },
      })
      .parse(req.query);
    const rows = (
      await db.query(
        "SELECT id,name,description,language,tags FROM member_network.communities WHERE status='approved' AND ($1::text IS NULL OR language=$1) AND ($2::text IS NULL OR $2=ANY(tags)) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4",
        [b.language ?? null, b.tag ?? null, b.after ?? null, b.limit],
      )
    ).rows;
    return {
      items: rows,
      next: rows.length === b.limit ? rows.at(-1).id : null,
    };
  });
  app.get("/api/me/recommendations", async (req) => {
    const m = await member(req);
    const rows = (
      await db.query(
        `SELECT c.id,c.name,c.description,c.language,c.tags,
      (SELECT count(*)::int FROM unnest(c.tags) t WHERE t=ANY($2::text[])) AS score
      FROM member_network.communities c WHERE c.status='approved'
      AND NOT EXISTS(SELECT 1 FROM member_network.consents s WHERE s.member_id=$1 AND s.community_id=c.id AND s.revoked_at IS NULL AND s.expires_at>now())
      ORDER BY score DESC,c.id LIMIT 25`,
        [m.id, m.interests],
      )
    ).rows;
    return rows.map((r) => ({
      ...r,
      reason: r.score
        ? "Minat yang cocok dengan profilmu"
        : "Komunitas yang telah ditinjau",
    }));
  });
  app.get("/api/admin/members", async (req) => {
    await admin(req, false, true);
    const p = page(req.query);
    const rows = (
      await db.query(
        "SELECT id,discord_id,username,active,connection_status,created_at FROM member_network.members WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2",
        [p.after ?? null, p.limit],
      )
    ).rows;
    return {
      items: rows,
      next: rows.length === p.limit ? rows.at(-1).id : null,
    };
  });
  app.patch("/api/admin/members/:id", async (req) => {
    const actor = await admin(req, true);
    const memberId = uuidParam(req);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    await db.tx(async (tx) => {
      const r = await one(
        tx,
        "UPDATE member_network.members SET active=$2,updated_at=now() WHERE id=$1 RETURNING id",
        [memberId, b.active],
      );
      if (!r) throw new Problem(404, "Anggota tidak ditemukan");
      await audit(tx, actor.id, "member.status", memberId, {
        active: b.active,
      });
    });
    return { ok: true };
  });
  app.post("/api/admin/members/:id/disconnect", async (req) => {
    const a = await admin(req, true);
    await svc.revokeConnection(uuidParam(req), a.id);
    worker.wake();
    return { ok: true };
  });
  app.get("/api/admin/members/:id/activity", async (req) => {
    await admin(req, false, true);
    return (
      await db.query(
        "SELECT action,entity,created_at FROM member_network.audit WHERE actor=$1 OR entity=$1 ORDER BY created_at DESC LIMIT 50",
        [uuidParam(req)],
      )
    ).rows;
  });
  for (const table of ["communities", "campaigns"])
    app.get(`/api/admin/${table}`, async (req) => {
      await admin(req);
      const p = page(req.query);
      const rows = (
        await db.query(
          `SELECT * FROM member_network.${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
          [p.after ?? null, p.limit],
        )
      ).rows;
      return {
        items: rows,
        next: rows.length === p.limit ? rows.at(-1).id : null,
      };
    });
  app.post("/api/admin/communities", async (req) => {
    const a = await admin(req, true);
    return svc.createCommunity(communityInput.parse(req.body), a.id);
  });
  app.patch("/api/admin/communities/:id", async (req) => {
    const a = await admin(req, true);
    const communityId = uuidParam(req);
    const b = z
      .object({ status: z.enum(["pending", "approved", "suspended"]) })
      .parse(req.body);
    await db.tx(async (tx) => {
      const r = await one(
        tx,
        "UPDATE member_network.communities SET status=$2 WHERE id=$1 RETURNING id",
        [communityId, b.status],
      );
      if (!r) throw new Problem(404, "Komunitas tidak ditemukan");
      await audit(tx, a.id, "community.status", communityId, b);
    });
    return { ok: true };
  });
  app.post("/api/admin/campaigns", async (req) => {
    const a = await admin(req, true);
    return svc.createCampaign(campaignInput.parse(req.body), a.id);
  });
  app.post("/api/admin/campaigns/:id/start", async (req) => {
    const a = await admin(req, true);
    if (!config.AUTO_JOIN_ENABLED)
      throw new Problem(409, "Auto-join belum diaktifkan oleh operator");
    const result = await svc.startCampaign(uuidParam(req), a.id);
    worker.wake();
    return result;
  });
  app.post("/api/admin/campaigns/:id/pause", async (req) => {
    const a = await admin(req, true);
    await db.tx(async (tx) => {
      const r = await one(
        tx,
        "UPDATE member_network.campaigns SET status='paused' WHERE id=$1 AND status IN ('draft','running','paused') RETURNING id",
        [uuidParam(req)],
      );
      if (!r)
        throw new Problem(409, "Campaign tidak tersedia atau sudah ditutup");
      await audit(tx, a.id, "campaign.pause", r.id);
    });
    return { ok: true };
  });
  app.post("/api/admin/campaigns/:id/complete", async (req) => {
    const a = await admin(req, true);
    const campaignId = uuidParam(req);
    await db.tx(async (tx) => {
      const c = await one(
        tx,
        "UPDATE member_network.campaigns SET status='completed' WHERE id=$1 RETURNING id",
        [campaignId],
      );
      if (!c) throw new Problem(404, "Campaign tidak ditemukan");
      await tx.query(
        "UPDATE member_network.jobs SET status='cancelled',updated_at=now() WHERE campaign_id=$1 AND status IN ('queued','retry')",
        [campaignId],
      );
      await audit(tx, a.id, "campaign.complete", campaignId);
    });
    return { ok: true };
  });
  app.get("/api/admin/campaigns/:id/jobs", async (req) => {
    await admin(req, false, true);
    const p = page(req.query);
    const rows = (
      await db.query(
        "SELECT id,status,error_code,attempts,updated_at FROM member_network.jobs WHERE campaign_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",
        [uuidParam(req), p.after ?? null, p.limit],
      )
    ).rows;
    return {
      items: rows,
      next: rows.length === p.limit ? rows.at(-1).id : null,
    };
  });
  app.get("/api/admin/analytics", async (req) => {
    await admin(req);
    return {
      members: Number(
        (await one(db, "SELECT count(*) FROM member_network.members")).count,
      ),
      communities: Number(
        (await one(db, "SELECT count(*) FROM member_network.communities"))
          .count,
      ),
      campaigns: Number(
        (await one(db, "SELECT count(*) FROM member_network.campaigns")).count,
      ),
      joins: (
        await db.query(
          "SELECT status,count(*)::int AS count FROM member_network.jobs GROUP BY status",
        )
      ).rows,
      daily: (
        await db.query(
          "SELECT updated_at::date AS day,status,count(*)::int AS count FROM member_network.jobs WHERE updated_at>now()-interval '30 days' GROUP BY 1,2 ORDER BY 1 DESC LIMIT 300",
        )
      ).rows,
      auto_join_enabled: config.AUTO_JOIN_ENABLED,
    };
  });
  app.get("/api/admin/audit", async (req) => {
    await admin(req, false, true);
    return (
      await db.query(
        "SELECT id,actor,action,entity,detail,created_at FROM member_network.audit ORDER BY created_at DESC LIMIT 100",
      )
    ).rows;
  });
  await app.register(staticFiles, {
    root: fileURLToPath(new URL("../public/", import.meta.url)),
    index: "index.html",
  });
  app.get("/admin", async (req, reply) => reply.sendFile("admin.html"));
  return app;
}
