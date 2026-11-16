import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { vault } from "../src/crypto.js";
import { service } from "../src/service.js";
import { worker } from "../src/worker.js";
import { buildApp } from "../src/app.js";
export const adminId = "10000000-0000-4000-8000-000000000001";
export const viewerId = "10000000-0000-4000-8000-000000000002";
export const outsiderId = "10000000-0000-4000-8000-000000000003";
export const config = {
  NODE_ENV: "test",
  APP_BASE_URL: "http://localhost:3000",
  DISCORD_APPLICATION_ID: "123456789012345678",
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "test-only",
  DISCORD_BOT_TOKEN: "test-only",
  DISCORD_REDIRECT_URI: "http://localhost:3000/auth/discord/callback",
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  ADMIN_USER_IDS: [adminId],
  VIEWER_USER_IDS: [viewerId],
  AUTO_JOIN_ENABLED: true,
  SUPABASE_URL: "https://identity.invalid",
  SUPABASE_PUBLISHABLE_KEY: "test-only",
};
export async function fixture() {
  const engine = new PGlite();
  await engine.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  const sql = await readFile(
    new URL("../db/schema.sql", import.meta.url),
    "utf8",
  );
  await engine.exec(sql);
  const db = {
    query: (sql, args) => engine.query(sql, args),
    tx: (fn) =>
      engine.transaction((tx) =>
        fn({ query: (sql, args) => tx.query(sql, args) }),
      ),
  };
  const crypt = vault(config.TOKEN_ENCRYPTION_KEY);
  const calls = { joins: [], revoke: 0, refresh: 0, exchange: 0 };
  const token = {
    access_token: "access-test",
    refresh_token: "refresh-test",
    scope: "identify guilds.join",
    expires_in: 3600,
  };
  const discord = {
    authorize: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    exchange: async () => {
      calls.exchange++;
      return token;
    },
    profile: async () => ({
      id: "234567890123456789",
      username: "Test Member",
    }),
    guild: async (id) => ({ id }),
    join: async (...args) => {
      calls.joins.push(args);
      return "added";
    },
    revoke: async () => {
      calls.revoke++;
    },
    refresh: async () => {
      calls.refresh++;
      return { ...token, access_token: "rotated-access" };
    },
  };
  const identity = {
    login: async (email, password) => {
      if (password !== "correct") throw new Error("invalid");
      return {
        access_token: email === "viewer@example.test" ? "viewer" : "admin",
        expires_in: 3600,
      };
    },
    user: async (token) => {
      if (!["admin", "viewer", "outsider"].includes(token))
        throw new Error("invalid");
      return {
        id: { admin: adminId, viewer: viewerId, outsider: outsiderId }[token],
      };
    },
  };
  const svc = service(db, crypt, discord, config);
  const work = worker(db, crypt, discord, config);
  const app = await buildApp({
    db,
    crypt,
    discord,
    identity,
    config,
    worker: work,
  });
  return {
    db,
    engine,
    sql,
    crypt,
    discord,
    identity,
    calls,
    token,
    svc,
    work,
    app,
    async close() {
      await work.stop();
      await app.close();
      await engine.close();
    },
  };
}
export async function member(f) {
  const m = (
    await f.db.query(
      "INSERT INTO member_network.members(discord_id,username,interests) VALUES ('234567890123456789','Test Member',ARRAY['gaming']) RETURNING *",
    )
  ).rows[0];
  await f.db.query(
    "INSERT INTO member_network.connections(member_id,encrypted_tokens,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [m.id, f.crypt.encrypt(f.token, m.id)],
  );
  return m;
}
export async function community(f) {
  return (
    await f.db.query(
      "INSERT INTO member_network.communities(guild_id,name,status,tags) VALUES ('345678901234567890','Test Community','approved',ARRAY['gaming']) RETURNING *",
    )
  ).rows[0];
}
export async function campaign(f, c) {
  return (
    await f.db.query(
      "INSERT INTO member_network.campaigns(community_id,name,starts_at,ends_at,member_limit) VALUES ($1,'Test Campaign',now()-interval '1 minute',now()+interval '1 day',2) RETURNING *",
      [c.id],
    )
  ).rows[0];
}
export async function queued(f) {
  const m = await member(f),
    c = await community(f),
    p = await campaign(f, c);
  await f.svc.consent(m.id, c.id);
  await f.svc.startCampaign(p.id, adminId);
  return { m, c, p };
}
export const headers = (token = "admin") => ({
  origin: "http://localhost:3000",
  authorization: `Bearer ${token}`,
});
